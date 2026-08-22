/**
 * Text-to-speech for the app. One entry point — {@link speak} — and a hard
 * rule: **audio never breaks gameplay.** Every failure path here degrades to
 * a `console.warn` and a silent resolve, so a missing voice, a refused
 * autoplay or a half-downloaded model can never leave a learner stuck on a
 * challenge.
 *
 * Two engines, picked per call:
 *
 * - **Kokoro** (`kokoro-js`, browser-local Kokoro-82M) for English, loaded
 *   lazily on first use. It is genuinely English-only as packaged — see the
 *   long note in `languages.ts` — so it is never used for anything else.
 * - **Web Speech API** for every other language, and as the fallback whenever
 *   Kokoro is unavailable, still loading, or fails.
 *
 * Synthesized clips are cached in memory per (text, voice) so replaying a
 * word is instant; the model files themselves are cached by Transformers.js
 * in the browser's Cache Storage.
 */

import { audioCacheKey, LruCache } from './cache';
import { bcp47For, kokoroSupports, kokoroVoiceFor } from './languages';
import { loadKokoro, onKokoroProgress, resetKokoro, synthesize, type TtsProgress } from './kokoro';
import {
	getTtsDevice,
	getTtsEngine,
	setTtsDevice as writeTtsDevice,
	setTtsEngine as writeTtsEngine,
	type TtsDevice,
	type TtsEngine
} from './prefs';
import { cancelWebSpeech, speakWithWebSpeech, webSpeechAvailable } from './webspeech';

export type { TtsDevice, TtsEngine } from './prefs';
export type { TtsProgress } from './kokoro';
export { getTtsEngine, getTtsDevice, DEFAULT_TTS_ENGINE, DEFAULT_TTS_DEVICE } from './prefs';
export { webgpuAvailable } from './kokoro';
export { bcp47For, kokoroSupports, KOKORO_MODEL_ID } from './languages';

/** Roughly a session's worth of replayed words. */
const AUDIO_CACHE_SIZE = 50;

const audioCache = new LruCache<Blob>(AUDIO_CACHE_SIZE);

/** The clip currently playing, so a new request can cut it off. */
let playing: HTMLAudioElement | null = null;

/**
 * Persists the engine choice. Changing it drops the cached audio: clips are
 * engine-specific, and a learner switching engines is usually doing it
 * *because* they disliked what they just heard.
 */
export function setTtsEngine(engine: TtsEngine): void {
	if (engine === getTtsEngine()) return;
	writeTtsEngine(engine);
	stopSpeaking();
	audioCache.clear();
}

/**
 * Persists where Kokoro runs. An ONNX session cannot change device, so the
 * loaded model and every clip it produced are thrown away; the next `speak()`
 * rebuilds on the new device.
 */
export function setTtsDevice(device: TtsDevice): void {
	if (device === getTtsDevice()) return;
	writeTtsDevice(device);
	stopSpeaking();
	resetKokoro();
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
 * Downloads and warms up the Kokoro model ahead of time (the Settings
 * button). Resolves when the model is ready; rejects only so the caller can
 * show an error — `speak()` itself never surfaces this.
 */
export async function preloadKokoro(onProgress?: (progress: TtsProgress) => void): Promise<void> {
	const unsubscribe = onProgress ? onKokoroProgress(onProgress) : undefined;
	try {
		await loadKokoro();
	} finally {
		unsubscribe?.();
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
		const voice = kokoroVoiceFor(language);
		if (voice) {
			try {
				const key = audioCacheKey(phrase, voice);
				let blob = audioCache.get(key);
				if (!blob) {
					blob = await synthesize(phrase, voice);
					audioCache.set(key, blob);
				}
				await playBlob(blob);
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
