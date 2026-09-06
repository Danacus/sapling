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
 * **Only synthesis is native.** The clip comes back as bytes and is played by
 * the webview's `<audio>`, exactly as in a browser. WebKitGTK plays a WAV
 * happily (given the GStreamer plugins the desktop shell carries); what it
 * cannot do is run the browser path's engine, which needs a 439 MB Emscripten
 * file package and a `SharedArrayBuffer` this webview does not have.
 *
 * `@tauri-apps/api` is imported dynamically and this whole module is imported
 * dynamically by `tts.ts`, gated on `inTauri()` — so a browser fetches neither.
 */

import type { TtsProgress } from './sherpa';

/** Where the Rust host announces model-download progress. Named there too. */
const PROGRESS_EVENT = 'tts://model-progress';

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

function tauri(): typeof api {
	api ??= Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(
		([core, event]) => ({ invoke: core.invoke, listen: event.listen })
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
