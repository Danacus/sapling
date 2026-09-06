/**
 * Kokoro on the desktop host — the third speech provider, behind an unchanged
 * `speak(text, lang)`.
 *
 * This module is `sherpa.ts`'s opposite number and offers `tts.ts` exactly the
 * same three things: make the model ready, subscribe to download progress,
 * synthesize a phrase to a WAV `Blob`. Everything above it — the language
 * mapping, the speaker table, the clip caches, the fallback to the browser
 * voice — is the same code the web build runs, because it is the same model
 * with the same speaker ids and the engine is the only thing that moved.
 *
 * **Playing the clip is native here too**, which is the one thing this module
 * offers that `sherpa.ts` does not (`playOnHost`, `stopOnHost`). The webview's
 * audio stack cannot do it: `<audio>` over a blob builds a fresh GStreamer
 * pipeline per clip and starts about a second late, and Web Audio — the way to
 * keep one pipeline — plays noise or silence in this webview. The measurements
 * are in `crates/sapling-desktop/src/tts/play.rs` and `docs/desktop.md`. So the
 * bytes go back across the IPC and the host makes the sound; `tts.ts` keeps the
 * caches and the decision, and falls back to the element path when the host
 * says it has no output device.
 *
 * `@tauri-apps/api` is imported dynamically and this whole module is imported
 * dynamically by `tts.ts`, gated on `inTauri()` — so a browser fetches neither.
 */

import type { TtsProgress } from './sherpa';

/** Where the Rust host announces model-download progress. Named there too. */
const PROGRESS_EVENT = 'tts://model-progress';

/**
 * How the host begins the one playback failure worth remembering. Named in
 * `crates/sapling-desktop/src/tts/play.rs` too, and the two must agree: every
 * other error from `tts_play` is about the clip that was handed over, and only
 * this one says the machine will never play anything.
 */
const NO_OUTPUT_DEVICE = 'no audio output device';

/**
 * The host has no audio output at all — not that this clip was bad.
 *
 * A distinct type because the two failures deserve opposite reactions: this one
 * is permanent for the session and `tts.ts` latches its fallback on it, while a
 * clip the host refuses is one clip.
 */
export class NoAudioOutput extends Error {}

/** One progress tick as the host emits it; `TtsProgress` minus the percentage. */
interface NativeProgress {
	file: string;
	loaded: number;
	total: number;
}

/** What `tts_status` answers. Mirrors the Rust `TtsStatus`. */
export interface NativeVoiceStatus {
	/** The model directory's name, e.g. `kokoro-multi-lang-v1_1`. */
	model: string;
	/** Every file the engine needs is on disk. */
	installed: boolean;
	/** Bytes the model occupies; 0 when nothing is installed. */
	bytes: number;
	/** Bytes a first install downloads. */
	downloadBytes: number;
	/** Whether the engine is loaded and warm in the host process. */
	loaded: boolean;
}

/** The two `@tauri-apps/api` entry points this module needs, loaded once. */
let api: Promise<{
	invoke: typeof import('@tauri-apps/api/core').invoke;
	listen: typeof import('@tauri-apps/api/event').listen;
}>;

/**
 * `invoke` once the import above has landed, kept beside the promise as a plain
 * value so {@link stopOnHost} can send without an `await`.
 *
 * That is not a micro-optimization, it is the ordering: `tts_stop` and
 * `tts_play` are two messages, and a stop that overtakes the play it was meant
 * to precede silences the *new* word instead of the old one. Before the module
 * has loaded this is `undefined`, and a stop is then correctly a no-op —
 * nothing can be playing on a host that has not been spoken to yet.
 */
let ready: Awaited<typeof api> | undefined;

function tauri(): typeof api {
	api ??= Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(
		([core, event]) => {
			ready = { invoke: core.invoke, listen: event.listen };
			return ready;
		}
	);
	return api;
}

// -- Progress ---------------------------------------------------------------

const listeners = new Set<(progress: TtsProgress) => void>();

/** The Tauri subscription, started once and never torn down. */
let listening: Promise<void> | undefined;

function ensureListening(): Promise<void> {
	listening ??= (async () => {
		const { listen } = await tauri();
		await listen<NativeProgress>(PROGRESS_EVENT, ({ payload }) => {
			const progress: TtsProgress = {
				file: payload.file,
				loaded: payload.loaded,
				total: payload.total,
				progress: payload.total > 0 ? Math.min(100, (payload.loaded / payload.total) * 100) : 0
			};
			for (const listener of listeners) listener(progress);
		});
	})();
	return listening;
}

// -- The provider -----------------------------------------------------------

/** Model state without downloading anything. */
export async function nativeVoiceStatus(): Promise<NativeVoiceStatus> {
	const { invoke } = await tauri();
	return invoke<NativeVoiceStatus>('tts_status');
}

/**
 * The shape `tts.ts` routes `'kokoro'` to when the app is running in Tauri.
 * Structurally identical to what `sherpa.ts` exports, which is what makes the
 * router a one-line choice rather than a branch per call site.
 */
export const nativeKokoro = {
	/**
	 * Makes the voice ready to speak: downloads and unpacks the model if it is
	 * not already here, and returns at once if it is.
	 *
	 * Unlike the browser's `initSherpa` this does *not* also load the engine —
	 * there is no command for that, deliberately. Loading is ~2s of CPU and it
	 * happens on the first phrase, which the session screen already asks for
	 * (`warmSpeech`) the moment a challenge is shown, well before anything is
	 * played.
	 */
	async init(): Promise<void> {
		// Subscribed before the download starts, or the first ticks are lost and
		// the progress bar jumps in from the middle.
		await ensureListening();
		const { invoke } = await tauri();
		await invoke<void>('tts_download');
	},

	/** Subscribes to download progress; the returned function unsubscribes. */
	onProgress(listener: (progress: TtsProgress) => void): () => void {
		listeners.add(listener);
		void ensureListening();
		return () => listeners.delete(listener);
	},

	/**
	 * One phrase, as a WAV blob.
	 *
	 * The host answers with a binary IPC payload, so the bytes arrive as an
	 * `ArrayBuffer` and become a `Blob` without a parse step — a `Vec<u8>`
	 * serialized as JSON would be megabytes of digits per sentence.
	 */
	async synthesize(text: string, speakerId: number, speed = 1): Promise<Blob> {
		const { invoke } = await tauri();
		const wav = await invoke<ArrayBuffer>('tts_synthesize', { text, sid: speakerId, speed });
		return new Blob([wav], { type: 'audio/wav' });
	}
};

// -- Playback ---------------------------------------------------------------

/**
 * Plays one WAV clip on the host, resolving when it finishes or is stopped.
 *
 * That resolve-when-finished contract is `speak()`'s and always has been, and
 * it is why there is no event to subscribe to: the command *is* the clip. A
 * second call cuts the first off, on the host, so it holds whether or not
 * {@link stopOnHost} was called in between.
 *
 * The bytes cross as a **raw** IPC body — `invoke` treats a `Uint8Array`
 * payload as one — because a clip is ~150 KB and a JSON array of numbers is
 * megabytes of digits to serialize on the window thread and parse on the other
 * side. It is the same reason `tts_synthesize` answers with a binary payload,
 * pointing the other way.
 *
 * Throws {@link NoAudioOutput} when the machine has no output device, and an
 * ordinary `Error` when the host would not play *this* clip.
 */
export async function playOnHost(clip: Blob): Promise<void> {
	const { invoke } = await tauri();
	const bytes = new Uint8Array(await clip.arrayBuffer());
	try {
		await invoke<void>('tts_play', bytes);
	} catch (cause) {
		const message = typeof cause === 'string' ? cause : String(cause);
		if (message.startsWith(NO_OUTPUT_DEVICE)) throw new NoAudioOutput(message);
		throw cause instanceof Error ? cause : new Error(message);
	}
}

/**
 * Cuts off whatever the host is playing, which is also what makes the pending
 * {@link playOnHost} resolve.
 *
 * Deliberately not `async` and deliberately not awaited: `stopSpeaking()` is
 * synchronous and sits on the path to every new phrase, so the message is sent
 * and the caller moves on. A failure here is not worth a fallback — the worst
 * case is a word that finishes when it should have been cut short.
 */
export function stopOnHost(): void {
	// `undefined` means the host has never been asked to play anything, so
	// there is nothing to stop. See `ready`.
	void ready?.invoke<void>('tts_stop').catch((cause: unknown) => {
		console.warn('[tts] Could not stop the clip playing on the host.', cause);
	});
}
