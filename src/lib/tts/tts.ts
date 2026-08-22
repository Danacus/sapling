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
 * Synthesized clips are cached in memory per (text, speaker) so replaying a
 * word is instant; the runtime's two big downloads are cached by the worker in
 * Cache Storage (`ll-tts-models`).
 */

import { audioCacheKey, LruCache } from './cache';
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
export type { KokoroSpeaker } from './languages';
export {
	getTtsEngine,
	getTtsVoice,
	DEFAULT_TTS_ENGINE,
	DEFAULT_TTS_VOICE
} from './prefs';
export { bcp47For, kokoroSupports, kokoroSpeakerFor, MANDARIN_SPEAKERS } from './languages';
export { KOKORO_MODEL_ID, RUNTIME_DOWNLOAD_BYTES, formatMb } from './models';

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
 * Persists the Mandarin voice. The model stays loaded — the speaker is just an
 * argument to each generation — but every cached clip was rendered in the old
 * voice, so they go.
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
				const key = audioCacheKey(phrase, speaker.name);
				let blob = audioCache.get(key);
				if (!blob) {
					blob = await synthesize(phrase, speaker.id);
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
