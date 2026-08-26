/**
 * Text-to-speech for the app. One entry point — {@link speak} — and a hard
 * rule: **audio never breaks gameplay.** Every failure path here degrades to
 * a `console.warn` and a silent resolve, so a missing voice, a refused
 * autoplay or a half-downloaded model can never leave a learner stuck on a
 * challenge.
 *
 * Two engines, picked per call:
 *
 * - **Kokoro** (Kokoro v1.1-zh under the sherpa-onnx WASM runtime, in a Web
 *   Worker) for Mandarin and English. Real Mandarin, including mixed zh/en
 *   sentences — see the note in `languages.ts` for exactly what it covers and
 *   `sherpa.worker.ts` for how the runtime is assembled.
 * - **Web Speech API** for every other language, and as the fallback whenever
 *   Kokoro is unavailable, still downloading, or fails.
 *
 * Synthesized clips are cached twice over — an in-memory LRU for this session,
 * then Cache Storage (`ll-tts-audio`) so a word drilled yesterday still plays
 * instantly today; the runtime's two big downloads live in their own bucket
 * (`ll-tts-models`), written by the worker.
 */

import { readClip, writeClip } from './audio-store';
import { audioCacheKey, audioCacheUrl, LruCache } from './cache';
import { bcp47For, kokoroSpeakerFor, kokoroSupports } from './languages';
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

export type { TtsEngine, TtsVoice } from './prefs';
export type { TtsProgress } from './sherpa';
/**
 * Subscribes to Kokoro's model-download progress (see `preloadKokoro`, which
 * uses the same hook). Exposed directly for callers — such as the TTS
 * test-bench — that want live progress during an ordinary {@link speak} call
 * rather than a separate explicit preload.
 */
export { onSherpaProgress } from './sherpa';
export type { KokoroSpeaker } from './languages';
export {
	getTtsEngine,
	getTtsVoice,
	DEFAULT_TTS_ENGINE,
	DEFAULT_TTS_VOICE
} from './prefs';
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

/** The clip currently playing, so a new request can cut it off. */
let playing: HTMLAudioElement | null = null;

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
	if (playing) {
		try {
			playing.pause();
		} catch {
			/* ignore */
		}
		playing = null;
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
	const unsubscribe = onProgress ? onSherpaProgress(onProgress) : undefined;
	try {
		await initSherpa();
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
 */
async function obtainClip(phrase: string, speaker: { id: number; name: string }): Promise<Blob> {
	const key = audioCacheKey(phrase, speaker.name);

	const cached = audioCache.get(key);
	if (cached) return cached;

	const pending = inflight.get(key);
	if (pending) return pending;

	const work = (async () => {
		let blob = await readClip(audioCacheUrl(phrase, speaker.name, KOKORO_SPEED));
		if (!blob) {
			blob = await synthesize(phrase, speaker.id, KOKORO_SPEED);
			void writeClip(audioCacheUrl(phrase, speaker.name, KOKORO_SPEED), blob);
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

/** Plays a WAV blob to completion. Resolves (never rejects) on playback errors. */
function playBlob(blob: Blob): Promise<void> {
	const url = URL.createObjectURL(blob);
	const audio = new Audio(url);
	playing = audio;

	return new Promise<void>((resolve) => {
		const finish = (): void => {
			if (playing === audio) playing = null;
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
				// throws, so a broken or absent Cache Storage costs a re-synthesis
				// and nothing else.
				await playBlob(await obtainClip(phrase, speaker));
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
