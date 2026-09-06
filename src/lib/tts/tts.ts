/**
 * Text-to-speech for the app. One entry point — {@link speak} — and a hard
 * rule: **audio never breaks gameplay.** Every failure path here degrades to
 * a `console.warn` and a silent resolve, so a missing voice, a refused
 * autoplay or a half-downloaded model can never leave a learner stuck on a
 * challenge.
 *
 * Two engines, picked per call:
 *
 * - **Kokoro** (Kokoro v1.1-zh) for Mandarin and English. Real Mandarin,
 *   including mixed zh/en sentences — see the note in `languages.ts` for
 *   exactly what it covers.
 * - **Web Speech API** for every other language, and as the fallback whenever
 *   Kokoro is unavailable, still downloading, or fails.
 *
 * ## Kokoro comes from the host, and there are two hosts
 *
 * The `'kokoro'` preference has never named a *runtime* — it names the good,
 * downloaded, neural voice — and there are now two implementations of it
 * behind one shape (`KokoroProvider`): `sherpa.ts`, the sherpa-onnx WASM build
 * in a Web Worker, and `native.ts`, the same model running natively in the
 * Tauri desktop host, which is the only way it can run there at all. The
 * speaker ids, the sample rate and the WAV framing are identical because it is
 * the same model, so everything below this line — the caches, the warm-up, the
 * fallback — is host-blind. {@link inTauri} decides, once.
 *
 * Synthesized clips are cached twice over — an in-memory LRU for this session,
 * then Cache Storage (`ll-tts-audio`) so a word drilled yesterday still plays
 * instantly today; the runtime's two big downloads live in their own bucket
 * (`ll-tts-models`), written by the worker. **On the desktop only the memory
 * tier is used**: native synthesis is roughly four times real time against the
 * browser's one-to-two seconds a phrase, so a clip is cheaper to re-make than
 * to keep, and the model already sits on disk as ordinary files.
 *
 * ## And two ways of playing it, for the same reason
 *
 * In a browser a clip is an `<audio>` element over a blob URL, which is the
 * cheapest correct thing there is. On WebKitGTK it is nothing of the sort: the
 * webview builds a whole GStreamer pipeline per element — load the blob, wire
 * up playbin, preroll, open a fresh sink stream on PulseAudio/PipeWire — with
 * parts of that on the web process's main thread. So every spoken word arrived
 * late and stalled the window, *including* the ones already in the LRU, where
 * the cache had only ever saved the synthesis.
 *
 * The desktop therefore plays through one long-lived `AudioContext`: the WAV is
 * parsed here (`wav.ts` — not `decodeAudioData`, which is that pipeline again),
 * copied into an `AudioBuffer` and started on a source node, and the graph
 * stays open for the session. {@link inTauri} decides this too. The browser
 * keeps the element deliberately: it is already instant there, and a phone's
 * `AudioContext` starts suspended and wants a user gesture that a warmed-up
 * auto-play does not have.
 *
 * The context is built on the **first play, never at import time**: on a
 * WebKitGTK without the GStreamer plugins `new AudioContext()` takes the whole
 * web process down with it — not an exception, the page simply vanishes — so it
 * must not be able to happen to someone who never asks for sound. If it cannot
 * be built or resumed, playback falls back to the element path and says so
 * once, because a host with a broken audio stack should degrade to what it did
 * before this existed rather than to silence.
 *
 * **Why not play it natively?** The host already holds the samples and could
 * open the sink itself. It would then owe the window an `ended` event, a stop
 * that races it, and a second home for the clip caches, all marshalled over
 * IPC — to save an `AudioBuffer` that this webview plays perfectly well once it
 * is no longer asked to build a pipeline per clip. The capability a host lends
 * is synthesis (`desktop.md`); the playing stays here.
 */

import { inTauri } from '$lib/platform';

import { readClip, writeClip } from './audio-store';
import { audioCacheKey, audioCacheUrl, LruCache } from './cache';
import { bcp47For, kokoroSpeakerFor, kokoroSupports } from './languages';
import { RUNTIME_DOWNLOAD_BYTES } from './models';
import { initSherpa, onSherpaProgress, synthesize, type TtsProgress } from './sherpa';
import {
	getTtsEngine,
	getTtsVoice,
	setTtsEngine as writeTtsEngine,
	setTtsVoice as writeTtsVoice,
	type TtsEngine,
	type TtsVoice
} from './prefs';
import { cancelWebSpeech, speakWithWebSpeech, webSpeechAvailable } from './webspeech';
import { decodeWav, type PcmClip } from './wav';

export type { TtsEngine, TtsVoice } from './prefs';
export type { TtsProgress } from './sherpa';
export type { KokoroSpeaker } from './languages';
export { getTtsEngine, getTtsVoice, DEFAULT_TTS_ENGINE, DEFAULT_TTS_VOICE } from './prefs';
export {
	bcp47For,
	isMandarin,
	kokoroSupports,
	kokoroSpeakerFor,
	MANDARIN_SPEAKERS
} from './languages';
export { KOKORO_MODEL_ID, RUNTIME_DOWNLOAD_BYTES, formatMb } from './models';
/** The stored-clip cache, for the Settings row that reports and clears it. */
export { audioCacheBytes, clearAudioCache } from './audio-store';
export { AUDIO_CACHE_MAX_BYTES, formatCacheSize } from './cache';

/** Roughly a session's worth of replayed words. */
const AUDIO_CACHE_SIZE = 50;

const audioCache = new LruCache<Blob>(AUDIO_CACHE_SIZE);

/**
 * Playback rate handed to Kokoro (1 = as trained). Threaded through both the
 * synthesis call and the cache key from one place, so the two can never
 * disagree about what a stored clip sounds like.
 */
const KOKORO_SPEED = 1;

/**
 * Whatever is making sound right now, and how to cut it off — an element on one
 * path, a source node on the other. Both stop the same way from out here, and
 * both raise the event their `finish` is waiting on when stopped, so a promise
 * handed to a caller always settles.
 */
interface Playing {
	stop(): void;
}

/** The clip currently playing, so a new request can cut it off. */
let playing: Playing | null = null;

// -- Which Kokoro ------------------------------------------------------------

/**
 * What a host has to offer for its `'kokoro'` to be usable here. Both
 * providers already had this shape; naming it is what lets the rest of the
 * module stop caring which one it got.
 */
export interface KokoroProvider {
	/** Downloads whatever is missing and resolves when the voice can speak. */
	init(): Promise<void>;
	/** Subscribes to download progress; the return value unsubscribes. */
	onProgress(listener: (progress: TtsProgress) => void): () => void;
	/** One phrase, as a WAV blob. */
	synthesize(text: string, speakerId: number, speed?: number): Promise<Blob>;
}

/** The browser's: sherpa-onnx compiled to WASM, in a Web Worker. */
const sherpaProvider: KokoroProvider = {
	init: initSherpa,
	onProgress: onSherpaProgress,
	synthesize
};

let provider: Promise<KokoroProvider> | undefined;

/**
 * The host's Kokoro, resolved once.
 *
 * The desktop module is reached through a dynamic import so a browser never
 * fetches it (and never sees a reference to `@tauri-apps/api`); the browser
 * branch is already loaded, so on the web this is a resolved promise and adds
 * a microtask, not a round trip.
 */
function kokoro(): Promise<KokoroProvider> {
	provider ??= inTauri()
		? import('./native').then((module) => module.nativeKokoro)
		: Promise.resolve(sherpaProvider);
	return provider;
}

/**
 * Whether stored clips are worth keeping on this host.
 *
 * The browser pays one to two seconds of WASM inference per phrase, which is
 * exactly what Cache Storage is there to avoid. The native engine runs at
 * several times real time, so re-synthesizing costs less than the reads,
 * writes and eviction sweeps of a hundred-megabyte on-disk cache — and the
 * memory LRU still absorbs the replays a learner actually fires off.
 */
function clipsWorthStoring(): boolean {
	return !inTauri();
}

/**
 * Whether to play through the Web Audio graph rather than an `<audio>` element
 * — the header explains what it costs where. Kept beside
 * {@link clipsWorthStoring} on purpose: both are the same question ("what does
 * this host make expensive?"), and the answers should be read together.
 */
function playsThroughGraph(): boolean {
	return inTauri();
}

/**
 * Subscribes to Kokoro's model-download progress on whichever host is
 * providing it (see `preloadKokoro`, which uses the same hook). Exposed
 * directly for callers — such as the TTS test-bench — that want live progress
 * during an ordinary {@link speak} call rather than a separate explicit
 * preload.
 *
 * Returns synchronously even though the provider does not: the unsubscribe it
 * hands back is honoured whether or not the provider has arrived yet.
 */
export function onVoiceProgress(listener: (progress: TtsProgress) => void): () => void {
	let cancelled = false;
	let unsubscribe: (() => void) | undefined;
	void kokoro().then((engine) => {
		if (cancelled) return;
		unsubscribe = engine.onProgress(listener);
	});
	return () => {
		cancelled = true;
		unsubscribe?.();
	};
}

/**
 * First-run download for the voice, in bytes — two files from a mirror in the
 * browser, one release archive on the desktop. Asked rather than imported
 * because only the host knows what it will fetch.
 */
export async function voiceDownloadBytes(): Promise<number> {
	if (!inTauri()) return RUNTIME_DOWNLOAD_BYTES;
	const { nativeVoiceStatus } = await import('./native');
	return (await nativeVoiceStatus()).downloadBytes;
}

/**
 * Persists the engine choice. Changing it drops the in-memory audio: clips are
 * engine-specific, and a learner switching engines is usually doing it
 * *because* they disliked what they just heard. Stored clips survive — only
 * Kokoro ever writes any, so switching away leaves them valid for a switch
 * back, and Settings has an explicit button for throwing them out.
 */
export function setTtsEngine(engine: TtsEngine): void {
	if (engine === getTtsEngine()) return;
	writeTtsEngine(engine);
	stopSpeaking();
	audioCache.clear();
}

/**
 * Persists the Mandarin voice. The model stays loaded — the speaker is just an
 * argument to each generation — but every clip in memory was rendered in the
 * old voice, so they go. The *stored* clips stay: their keys carry the speaker
 * (see `audioCacheUrl`), so they cannot be mistaken for the new voice, and
 * switching back is instant instead of a fresh round of synthesis.
 */
export function setTtsVoice(voice: TtsVoice): void {
	if (voice === getTtsVoice()) return;
	writeTtsVoice(voice);
	stopSpeaking();
	audioCache.clear();
}

/** Cuts off whatever is playing, on either engine. */
export function stopSpeaking(): void {
	const current = playing;
	playing = null;
	if (current) {
		try {
			current.stop();
		} catch {
			/* ignore: it had already finished */
		}
	}
	cancelWebSpeech();
}

/**
 * Whether tapping a speaker button would produce anything. `false` turns the
 * buttons into a disabled affordance rather than hiding them, so the learner
 * can see the feature exists and where to switch it on.
 */
export function ttsAvailable(language: string | undefined): boolean {
	const engine = getTtsEngine();
	if (engine === 'off') return false;
	if (engine === 'kokoro' && kokoroSupports(language)) return true;
	return webSpeechAvailable();
}

/**
 * Downloads and warms up the Kokoro runtime ahead of time (the Settings
 * button). Resolves when the model is ready; rejects only so the caller can
 * show an error — `speak()` itself never surfaces this.
 */
export async function preloadKokoro(onProgress?: (progress: TtsProgress) => void): Promise<void> {
	const engine = await kokoro();
	const unsubscribe = onProgress ? engine.onProgress(onProgress) : undefined;
	try {
		await engine.init();
	} finally {
		unsubscribe?.();
	}
}

/**
 * Synthesis calls in flight, keyed like the memory cache. A warm-up racing a
 * real `speak` of the same phrase (the common case: the answer's audio starts
 * warming when the challenge is shown, and a fast learner answers before the
 * render finishes) must share one synthesis, not queue two on the worker.
 */
const inflight = new Map<string, Promise<Blob>>();

/**
 * One clip, wherever it is cheapest: memory LRU → Cache Storage → synthesis,
 * writing through to both on a miss and deduplicating concurrent requests for
 * the same phrase. Throws only when synthesis itself fails.
 *
 * The stored tier is skipped where it does not pay for itself — see
 * {@link clipsWorthStoring} — leaving the memory LRU and the dedupe, which
 * both hosts want.
 */
async function obtainClip(phrase: string, speaker: { id: number; name: string }): Promise<Blob> {
	const key = audioCacheKey(phrase, speaker.name);

	const cached = audioCache.get(key);
	if (cached) return cached;

	const pending = inflight.get(key);
	if (pending) return pending;

	const work = (async () => {
		const url = audioCacheUrl(phrase, speaker.name, KOKORO_SPEED);
		const stored = clipsWorthStoring();
		let blob = stored ? await readClip(url) : undefined;
		if (!blob) {
			blob = await (await kokoro()).synthesize(phrase, speaker.id, KOKORO_SPEED);
			if (stored) void writeClip(url, blob);
		}
		audioCache.set(key, blob);
		return blob;
	})();

	inflight.set(key, work);
	try {
		return await work;
	} finally {
		inflight.delete(key);
	}
}

/**
 * Renders `text` into the caches without playing it.
 *
 * The session screen calls this the moment a challenge is shown: the learner
 * takes seconds to answer while Kokoro takes one or two to synthesize, so by
 * the time the feedback banner wants to auto-play the answer the clip is
 * already local and playback is instant — which also keeps the play inside the
 * click's user-activation window instead of arriving after it. Fire-and-forget
 * safe: every failure is swallowed, warming is only ever an optimization.
 * Web Speech has nothing to warm (the OS synthesizes at play time).
 *
 * On the desktop this is also where the engine's one-off load lands — the
 * native host has no separate warm-up command, and the seconds it takes are
 * spent while the challenge is being read rather than after an answer.
 */
export async function warmSpeech(text: string, language: string): Promise<void> {
	const phrase = text?.trim();
	if (!phrase || getTtsEngine() !== 'kokoro') return;
	const speaker = kokoroSpeakerFor(language);
	if (!speaker) return;
	try {
		await obtainClip(phrase, speaker);
	} catch {
		/* the real speak() will retry and fall back; a failed warm costs nothing */
	}
}

// -- Playing it --------------------------------------------------------------

/**
 * The session's one `AudioContext`: `undefined` until the first clip asks for
 * it, `null` once it is known not to be available. Never built at import time
 * — see the header; on a WebKitGTK missing its GStreamer plugins that call ends
 * the web process.
 */
let graph: AudioContext | null | undefined;

/** The graph, opened on demand and resumed, or `null` if this host has none. */
async function audioGraph(): Promise<AudioContext | null> {
	if (graph === null) return null;
	try {
		graph ??= new AudioContext();
		// Autoplay policies park a context created outside a gesture; on the
		// desktop nothing parks it, but resuming a running one is free.
		if (graph.state === 'suspended') await graph.resume();
		return graph;
	} catch (cause) {
		// Once for the session, not once per clip: an audio stack that cannot
		// give us an output is not going to start, and the element path below is
		// a complete answer, so repeating this would be noise.
		console.warn('[tts] Web Audio is unavailable; playing through <audio> instead.', cause);
		graph = null;
		return null;
	}
}

/** Plays raw samples through the graph. Resolves when they stop sounding. */
function playSamples(context: AudioContext, clip: PcmClip): Promise<void> {
	// `createBuffer` rejects a zero length, and there is nothing to hear anyway.
	if (clip.samples.length === 0) return Promise.resolve();

	const buffer = context.createBuffer(1, clip.samples.length, clip.sampleRate);
	buffer.copyToChannel(clip.samples, 0);

	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);

	return new Promise<void>((resolve) => {
		const handle: Playing = { stop: () => source.stop() };
		const finish = (): void => {
			if (playing === handle) playing = null;
			resolve();
		};
		// `stop()` raises `ended` as well, so a clip cut off by the next tap
		// leaves through the same door as one that ran out.
		source.onended = finish;
		playing = handle;
		try {
			source.start();
		} catch (cause) {
			console.warn('[tts] Could not start playback.', cause);
			finish();
		}
	});
}

/** Plays a WAV blob through an element and a blob URL — the browser's path. */
function playElement(blob: Blob): Promise<void> {
	const url = URL.createObjectURL(blob);
	const audio = new Audio(url);
	const handle: Playing = { stop: () => audio.pause() };
	playing = handle;

	return new Promise<void>((resolve) => {
		const finish = (): void => {
			if (playing === handle) playing = null;
			URL.revokeObjectURL(url);
			resolve();
		};
		audio.onended = finish;
		audio.onerror = () => {
			console.warn('[tts] Could not play the generated audio.');
			finish();
		};
		// A paused clip (a second tap arrived) resolves through here too.
		audio.onpause = finish;
		audio.play().catch((cause) => {
			console.warn('[tts] Playback was blocked.', cause);
			finish();
		});
	});
}

/** Plays a WAV blob to completion. Resolves (never rejects) on playback errors. */
async function playClip(blob: Blob): Promise<void> {
	if (playsThroughGraph()) {
		const context = await audioGraph();
		if (context) {
			try {
				await playSamples(context, decodeWav(await blob.arrayBuffer()));
				return;
			} catch (cause) {
				// These are our own bytes, so this is close to impossible — but the
				// element path is right there and silence is the one outcome we do
				// not accept.
				console.warn('[tts] Could not play that clip through Web Audio.', cause);
			}
		}
	}
	await playElement(blob);
}

/**
 * Speaks `text` in `language` (the profile's free-text `targetLanguage`) and
 * resolves when playback finishes.
 *
 * Blank text, engine `off`, an unknown language or any engine failure all
 * resolve quietly. A second call cuts off the first.
 */
export async function speak(text: string, language: string): Promise<void> {
	const phrase = text?.trim();
	if (!phrase) return;

	const engine = getTtsEngine();
	if (engine === 'off') return;

	stopSpeaking();

	if (engine === 'kokoro') {
		const speaker = kokoroSpeakerFor(language);
		if (speaker) {
			try {
				// Memory → disk → synthesize (see `obtainClip`); the disk layer never
				// throws, and is skipped entirely on a host where it does not pay,
				// so a broken, absent or bypassed Cache Storage costs a
				// re-synthesis and nothing else.
				await playClip(await obtainClip(phrase, speaker));
				return;
			} catch (cause) {
				console.warn('[tts] Kokoro failed; falling back to the browser voice.', cause);
			}
		}
	}

	try {
		await speakWithWebSpeech(phrase, bcp47For(language));
	} catch (cause) {
		// speakWithWebSpeech already swallows its own errors; belt and braces.
		console.warn('[tts] Could not speak that.', cause);
	}
}
