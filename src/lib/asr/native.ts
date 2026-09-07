/**
 * Dictation on a Tauri host — the second backend behind an unchanged
 * `listen(language, handlers)`.
 *
 * `webspeech.ts`'s opposite number and `tts/native.ts`'s sibling: three
 * `invoke`s and one Tauri event listener, plus the one thing the voice's
 * counterpart does not need — the microphone itself. `@tauri-apps/api` is
 * imported dynamically and this whole module is imported dynamically by
 * `index.ts`, gated on `inTauri()`, so a browser fetches neither.
 *
 * ## The audio is captured here, in the WebView, on both hosts
 *
 * The desktop moved *playback* to the host for a measured reason — WebKitGTK
 * builds a fresh GStreamer pipeline per `<audio>` clip — and nothing like it
 * applies to capture: `getUserMedia` works in both webviews, permissions are
 * the browser's, and one code path serves the desktop and Android alike. So the
 * host has no microphone in it at all. It is handed samples that are already
 * recorded, as a raw IPC body, exactly as `tts_play` is handed a clip and for
 * the same arithmetic: ten seconds of 16 kHz 16-bit mono is ~320 KB, and a JSON
 * array of decimal digits is megabytes of text to serialize on this thread.
 *
 * The graph is `getUserMedia` → `AudioWorkletNode`, and it stops there:
 * **nothing is connected to `AudioContext.destination`**, because the node is
 * built with `numberOfOutputs: 0`. That is not tidiness either — on the desktop
 * host Web Audio *output* is measured to play noise or silence, and a recorder
 * that had to reach the speakers to be pulled is the one shape that could make
 * a sound while the learner is talking.
 *
 * ## What the contract costs, and where it is paid
 *
 * `listen` must answer *synchronously*: `undefined` for "this cannot start, and
 * no handler will ever fire", or a session that is guaranteed exactly one
 * `onEnd`. Opening a microphone is asynchronous. So {@link dictateNatively}
 * splits the question: the synchronous half is whether this window has
 * `getUserMedia` and an `AudioContext` at all, and everything after that —
 * a refused permission, a worklet that would not load, a host that rejected the
 * transcription — is a session that ends, once, with or without a message.
 *
 * A message only for a microphone the learner can still fix, and in
 * `micErrorMessage`'s own words rather than new ones. Everything else is
 * silent: the point of dictation is that its failures cost a learner nothing
 * but the typing they were going to do anyway.
 */

import { base } from '$app/paths';

import { micErrorMessage, type DictationHandlers, type DictationSession } from './webspeech';
import { frameUtterance, peakOf, TARGET_SAMPLE_RATE } from './pcm';

/** Where the Rust host announces model-download progress. Named there too. */
const PROGRESS_EVENT = 'asr://model-progress';

/**
 * The capture worklet, in `static/` and therefore outside Vite — see the file
 * itself. `base` is SvelteKit's configured base path (`''` unless the app is
 * deployed under a sub-path), read here for the reason `ttsAssetUrl` documents:
 * an assumed `/` would silently break the worklet under one.
 */
const WORKLET_URL = `${base}/asr/pcm-worklet.js`;

/** One progress tick as the host emits it. The same shape the voice emits. */
interface NativeProgress {
	file: string;
	loaded: number;
	total: number;
}

/** What a caller watching an install is told; `TtsProgress`'s shape. */
export interface AsrProgress {
	file: string;
	loaded: number;
	total: number;
	progress: number;
}

/** What `asr_status` answers. Mirrors the Rust `AsrStatus`. */
export interface NativeAsrStatus {
	/** The model directory's name, e.g. `sherpa-onnx-sense-voice-…`. */
	model: string;
	/** Every file the recognizer needs is on disk. */
	installed: boolean;
	/** Bytes the model occupies; 0 when nothing is installed. */
	bytes: number;
	/** Bytes a first install downloads. */
	downloadBytes: number;
	/** Whether the recognizer is loaded and warm in the host process. */
	loaded: boolean;
	/**
	 * BCP-47 primary subtags this host can transcribe. **Asked rather than
	 * hard-coded**, so swapping the model is a `ModelSpec` change in the crate
	 * and nothing at all on this side.
	 */
	languages: string[];
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

const listeners = new Set<(progress: AsrProgress) => void>();

/** The Tauri subscription, started once and never torn down. */
let listening: Promise<void> | undefined;

function ensureListening(): Promise<void> {
	listening ??= (async () => {
		const { listen } = await tauri();
		await listen<NativeProgress>(PROGRESS_EVENT, ({ payload }) => {
			const progress: AsrProgress = {
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

// -- The three commands -----------------------------------------------------

/** Model state without downloading anything. `index.ts` asks this once. */
export async function nativeAsrStatus(): Promise<NativeAsrStatus> {
	const { invoke } = await tauri();
	return invoke<NativeAsrStatus>('asr_status');
}

/**
 * Downloads and unpacks the recognition model if it is not already here, and
 * returns at once if it is.
 *
 * Like the voice's `init`, this does *not* load the engine — there is no
 * command for that. The load is ~1 s and happens on the first utterance, which
 * the learner has just finished speaking.
 */
export async function installAsrModel(): Promise<void> {
	// Subscribed before the download starts, or the first ticks are lost and
	// the progress bar jumps in from the middle.
	await ensureListening();
	const { invoke } = await tauri();
	await invoke<void>('asr_download');
}

/** Subscribes to download progress; the returned function unsubscribes. */
export function onAsrProgress(listener: (progress: AsrProgress) => void): () => void {
	listeners.add(listener);
	void ensureListening();
	return () => listeners.delete(listener);
}

/**
 * One utterance, as 16 kHz 16-bit little-endian mono PCM, to one sentence.
 *
 * The bytes cross as a **raw** IPC body — `invoke` treats a `Uint8Array`
 * payload as one — for the reason the module header gives.
 */
async function transcribe(pcm: Uint8Array): Promise<string> {
	const { invoke } = await tauri();
	return invoke<string>('asr_transcribe', pcm);
}

// -- The microphone ---------------------------------------------------------

/** An open microphone and everything it has heard so far. */
interface Capture {
	sampleRate: number;
	/** Releases the device and hands back every quantum captured. */
	close(): Float32Array[];
}

/**
 * Whether this window could open a microphone at all — the synchronous half of
 * `listen`'s contract, and the only thing that makes it answer `undefined`.
 *
 * Deliberately not a permission check: a learner who has not been asked yet,
 * or who said no last time, is a session that ends with a message, not a
 * button that was never drawn.
 */
export function captureAvailable(): boolean {
	return (
		typeof navigator !== 'undefined' &&
		typeof navigator.mediaDevices?.getUserMedia === 'function' &&
		typeof AudioContext === 'function'
	);
}

/**
 * Opens the microphone and starts collecting.
 *
 * The context is asked for {@link TARGET_SAMPLE_RATE} so the browser's own
 * resampler does the work; a browser that refuses the option gets a default
 * context and `pcm.ts` resamples instead. Which one happened is carried out on
 * {@link Capture.sampleRate} rather than assumed.
 */
async function openMicrophone(context: AudioContext): Promise<Capture> {
	// The stage lines below are the only trace a phone leaves: logcat shows the
	// WebView's console and nothing else, and a dictation that hangs at any of
	// these awaits is otherwise indistinguishable from one that never began.
	console.info(`[asr] asking for the microphone; context ${context.state}`);
	const stream = await navigator.mediaDevices.getUserMedia({
		// One channel, because the model is mono and a stereo capture would only
		// be downmixed. The three cleanups are the browser's own and are exactly
		// what a dictating learner in a room wants.
		audio: {
			channelCount: 1,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true
		}
	});

	try {
		console.info(`[asr] microphone granted; loading the worklet from ${WORKLET_URL}`);
		await context.audioWorklet.addModule(WORKLET_URL);
		console.info(`[asr] worklet loaded; context ${context.state} at ${context.sampleRate} Hz`);
		const source = context.createMediaStreamSource(stream);
		// `numberOfOutputs: 0` is the whole reason this graph never reaches an
		// output device. See the module header.
		const collector = new AudioWorkletNode(context, 'pcm-collector', {
			numberOfInputs: 1,
			numberOfOutputs: 0
		});

		const chunks: Float32Array[] = [];
		collector.port.onmessage = (event: MessageEvent<Float32Array>) => {
			chunks.push(event.data);
		};
		source.connect(collector);

		const open = context;
		return {
			sampleRate: open.sampleRate,
			close(): Float32Array[] {
				collector.port.onmessage = null;
				source.disconnect();
				// The device light goes out here, and it is the part that must
				// happen even if everything after it throws.
				for (const track of stream.getTracks()) track.stop();
				void open.close().catch(() => {});
				return chunks;
			}
		};
	} catch (cause) {
		for (const track of stream.getTracks()) track.stop();
		throw cause;
	}
}

/**
 * The context, opened **synchronously, inside the tap**.
 *
 * Chromium's autoplay policy — Android's WebView included — lets a context
 * start only during a user gesture. The permission prompt is an `await` away
 * from the tap, and by the time it resolves the gesture is spent: a context
 * created then is born `suspended`, the worklet never runs, and the utterance
 * is zero samples that end silently as "nothing was said". So the context is
 * made and resumed here, before anything is awaited, and handed to
 * {@link openMicrophone}. The resume is not awaited — `dictateNatively` is
 * synchronous by contract — and its outcome is read off `state` when the
 * capture closes, where it is the first thing a dropped utterance reports.
 */
function openContext(): AudioContext {
	let context: AudioContext;
	try {
		context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
	} catch {
		// A browser that will not open a context at that rate. Not worth a
		// warning: the samples are resampled on the way out either way.
		context = new AudioContext();
	}
	void context.resume().catch(() => {});
	return context;
}

/**
 * What to tell the learner about a `getUserMedia` failure, in the vocabulary
 * `micErrorMessage` already uses for the browser engine — so the two backends
 * cannot end up wording the same problem two ways.
 *
 * A `DOMException` name maps onto a Web Speech error code, and everything
 * unrecognized maps onto nothing, which is `micErrorMessage`'s own default and
 * means the session ends silently.
 */
function captureErrorMessage(cause: unknown): string | undefined {
	const name = cause instanceof Error ? cause.name : '';
	switch (name) {
		case 'NotAllowedError':
		case 'SecurityError':
			return micErrorMessage('not-allowed');
		case 'NotFoundError':
		case 'OverconstrainedError':
		// The device is there and something else has it. "No microphone found"
		// is not exactly right, but it is the same thing to do about it, and a
		// fourth phrasing of "your microphone is not working" is worse than an
		// approximate one the learner has seen before.
		case 'NotReadableError':
			return micErrorMessage('audio-capture');
		default:
			return undefined;
	}
}

/**
 * Opens the microphone for one utterance and transcribes it on the host.
 *
 * Returns `undefined` only when this window cannot capture audio at all, in
 * which case no handler fires. Otherwise `onEnd` runs exactly once, on every
 * path: the learner stopping, the learner aborting, a refused permission, a
 * silent utterance, or a host that would not transcribe.
 *
 * There is one `onTranscript`, with `final` true, and only when there are words
 * — this model answers once for a whole utterance and there is nothing interim
 * to show. The handler shape already allows a streaming backend to fill in the
 * middle later; this one has no middle.
 */
export function dictateNatively(handlers: DictationHandlers): DictationSession | undefined {
	if (!captureAvailable()) return undefined;

	// Before anything is awaited: see `openContext`.
	const context = openContext();

	let ended = false;
	/** Set once the microphone is open, and cleared the moment it closes. */
	let capture: Capture | undefined;
	/** What the learner asked for while the microphone was still opening. */
	let requested: 'stop' | 'abort' | undefined;

	const finish = (message?: string): void => {
		if (ended) return;
		ended = true;
		handlers.onEnd(message);
	};

	/** Closes the microphone if it is open, and hands back what it heard. */
	const release = (): { chunks: Float32Array[]; sampleRate: number } => {
		const open = capture;
		capture = undefined;
		if (!open) return { chunks: [], sampleRate: TARGET_SAMPLE_RATE };
		return { chunks: open.close(), sampleRate: open.sampleRate };
	};

	/** The stop path: close, frame, transcribe, report, end. */
	const settle = async (): Promise<void> => {
		const { chunks, sampleRate } = release();
		const pcm = frameUtterance(chunks, sampleRate);
		// Nothing was said. Silent to the learner, exactly as `no-speech` is —
		// but said to the console, because a context that never ran, a worklet
		// that never posted and a muted microphone all arrive here looking the
		// same, and this line is what tells them apart on a phone.
		if (!pcm) {
			const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
			const peak = chunks.reduce((loudest, chunk) => Math.max(loudest, peakOf(chunk)), 0);
			console.warn(
				`[asr] Nothing to transcribe: ${samples} samples at ${sampleRate} Hz, peak ${peak.toFixed(4)}, context ${context.state}.`
			);
			return finish();
		}

		try {
			const started = Date.now();
			const text = (await transcribe(pcm)).trim();
			console.info(
				`[asr] transcribed ${pcm.byteLength} bytes into ${text.length} characters in ${Date.now() - started} ms`
			);
			if (text) handlers.onTranscript(text, true);
		} catch (cause) {
			// The host refused, or has no recognizer after all. The learner
			// still has the composer, which is the whole fallback there has
			// ever been for dictation.
			console.warn('[asr] The host could not transcribe that.', cause);
		}
		finish();
	};

	void (async () => {
		try {
			const open = await openMicrophone(context);
			// The learner was faster than the permission prompt.
			if (requested) {
				capture = open;
				if (requested === 'abort') {
					release();
					finish();
				} else {
					await settle();
				}
				return;
			}
			capture = open;
		} catch (cause) {
			// Warned unconditionally, unlike `webspeech.ts`, which stays quiet for
			// the codes that are ordinary stops. Nothing reaches here that is
			// ordinary: it is a refused permission, a device that is not there, or
			// a worklet that would not load — and only the first two of those have
			// anything to say to the learner.
			console.warn('[asr] Could not open the microphone.', cause);
			void context.close().catch(() => {});
			finish(captureErrorMessage(cause));
		}
	})();

	return {
		stop(): void {
			if (ended) return;
			console.info(`[asr] stop pressed; microphone ${capture ? 'open' : 'still opening'}`);
			if (!capture) {
				// Still opening: remembered, and acted on when it lands.
				requested ??= 'stop';
				return;
			}
			void settle();
		},
		abort(): void {
			if (ended) return;
			requested ??= 'abort';
			release();
			finish();
		}
	};
}
