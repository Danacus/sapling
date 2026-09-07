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
 * And a Tauri host may have **no** voice: the same shell built for Android
 * compiles the native one out (`crates/sapling-desktop/Cargo.toml`), so its
 * five commands are not there at all. That is a question about the host, not
 * about the platform, so it is asked of the host — one `tts_status` probe,
 * memoised — and a host that cannot answer gets a provider whose every call
 * fails, which is the path `speak` has always taken to the browser voice.
 *
 * ## And so does the *player*, on the desktop
 *
 * A clip is an `<audio>` element over a blob everywhere except inside Tauri,
 * where the webview's audio stack cannot do the job: `<audio>` starts about a
 * second late per clip because WebKitGTK builds a fresh GStreamer pipeline for
 * each one, and Web Audio plays noise or silence there. So `playClip` sends the
 * bytes back to the host, which owns one output stream for the process. The
 * element path stays as that host's fallback, because a slow word beats none.
 *
 * Synthesized clips are cached twice over — an in-memory LRU for this session,
 * then Cache Storage (`ll-tts-audio`) so a word drilled yesterday still plays
 * instantly today; the runtime's two big downloads live in their own bucket
 * (`ll-tts-models`), written by the worker. **On the desktop only the memory
 * tier is used**: native synthesis is roughly four times real time against the
 * browser's one-to-two seconds a phrase, so a clip is cheaper to re-make than
 * to keep, and the model already sits on disk as ordinary files.
 */

import { inTauri } from '$lib/platform';

import { readClip, writeClip } from './audio-store';
import { audioCacheKey, audioCacheUrl, LruCache } from './cache';
import { bcp47For, kokoroSpeakerFor, kokoroSupports } from './languages';
import { RUNTIME_DOWNLOAD_BYTES } from './models';
// Type-only, so the browser bundle still never references the desktop module.
import type { NativeVoiceStatus } from './native';
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
 * The clip currently playing and how to cut it off, or `null` for none.
 *
 * A token rather than the player itself, because there are two players now —
 * an `<audio>` element in a browser, the Rust host on the desktop — and the
 * only thing this module wants from either is "stop". Identity is what tells
 * two clips apart: a finishing clip clears this slot only if it is still the
 * one in it.
 */
let playing: { stop: () => void } | null = null;

/**
 * Whether the desktop host can play anything. Latched to `false` the first time
 * it answers that it has no output device — a machine does not grow a sound
 * card mid-session, and retrying per clip would mean the same warning on every
 * spoken word. A clip the host merely *refuses* does not latch this; that is
 * one clip's problem. See {@link playClip}.
 */
let hostPlayback = true;

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

/** What a host with no voice at all answers, to `speak` and to Settings alike. */
const NO_HOST_VOICE = 'this host has no built-in voice';

/**
 * A host that lends no voice — the Android build of the desktop shell, whose
 * five voice commands are compiled out.
 *
 * It fails the way a refused synthesis fails, on purpose: that is a path every
 * caller here already has, so "this host has none" needs no new branch in
 * {@link speak}, {@link warmSpeech} or the preload task. The learner hears the
 * browser voice, which is what they would have heard before the model was
 * downloaded.
 */
const voicelessHost: KokoroProvider = {
	init: () => Promise.reject(new Error(NO_HOST_VOICE)),
	onProgress: () => () => {},
	synthesize: () => Promise.reject(new Error(NO_HOST_VOICE))
};

let provider: Promise<KokoroProvider> | undefined;
let hostStatus: Promise<NativeVoiceStatus | undefined> | undefined;

/**
 * What the desktop host says about its voice, asked once, or `undefined` when
 * it has none to say anything about.
 *
 * `tts_status` is the probe because it is the one voice command that reads the
 * disk and nothing else — no lock, no download, no engine load — so asking it
 * costs an IPC round trip and answers two questions at once: whether the
 * commands exist at all, and what a first install would cost
 * ({@link voiceDownloadBytes}). Its rejection is not an error to report: a host
 * without the voice compiled in rejects every `invoke` of it, and that is a
 * fact about the build, warned about once and then forgotten.
 *
 * The import is a statement of its own, and the call another, on purpose. Vite
 * wraps a dynamic import in its preload helper, and a `.then(...)` chained
 * straight onto the `import()` expression is wrapped *with* it — so a
 * rejection from inside that `.then` is reported as `vite:preloadError`, a
 * chunk that failed to load, and the layout's heal-by-reload fires for a host
 * that merely has no `tts_status`. That was one reload on every first visit to
 * Settings on Android. Awaiting the module first keeps the helper around the
 * import alone.
 */
function hostVoice(): Promise<NativeVoiceStatus | undefined> {
	hostStatus ??= probeHostVoice().catch((cause) => {
		console.warn('[tts] This host has no voice of its own; the browser voice will speak.', cause);
		return undefined;
	});
	return hostStatus;
}

async function probeHostVoice(): Promise<NativeVoiceStatus> {
	const module = await import('./native');
	return module.nativeVoiceStatus();
}

/**
 * The host's Kokoro, resolved once — or {@link voicelessHost} when the host has
 * none to lend.
 *
 * The desktop module is reached through a dynamic import so a browser never
 * fetches it (and never sees a reference to `@tauri-apps/api`); the browser
 * branch is already loaded, so on the web this is a resolved promise and adds
 * a microtask, not a round trip. In Tauri it costs one {@link hostVoice} probe
 * before the first phrase, which is nothing beside the seconds the engine takes
 * to load, and it is paid once for the session.
 */
function kokoro(): Promise<KokoroProvider> {
	provider ??= inTauri()
		? hostVoice().then(async (status) =>
				status ? (await import('./native')).nativeKokoro : voicelessHost
			)
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
 * browser, one release archive on the desktop, and **nothing at all** on a host
 * that has no voice to download. Asked rather than imported because only the
 * host knows what it will fetch.
 *
 * Never rejects: Settings fires this off without waiting for it
 * (`+page.svelte`), so a rejection here would be an unhandled one.
 */
export async function voiceDownloadBytes(): Promise<number> {
	if (!inTauri()) return RUNTIME_DOWNLOAD_BYTES;
	return (await hostVoice())?.downloadBytes ?? 0;
}

/**
 * How many times over the install reports the same megabytes.
 *
 * The browser fetches its two runtime files and is finished — one pass. The
 * desktop host fetches one archive and then unpacks it, reporting both halves
 * against the archive's own size (`crates/sapling-desktop/src/tts/model.rs`),
 * so there the progress events cross the model twice.
 *
 * Asked rather than inferred from the events, for the same reason
 * {@link voiceDownloadBytes} is asked rather than imported: only the host knows
 * what it is going to do. The second pass is not announced until the first has
 * finished, which is too late for a bar that may not go backwards — see
 * `$lib/tasks/kinds/tts-model`, which is the one caller.
 */
export function voiceInstallPasses(): number {
	return inTauri() ? 2 : 1;
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

/** Cuts off whatever is playing, on either engine and on either player. */
export function stopSpeaking(): void {
	const current = playing;
	playing = null;
	if (current) {
		try {
			current.stop();
		} catch {
			/* ignore */
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

/**
 * Plays a WAV blob through an `<audio>` element, to completion. Resolves (never
 * rejects) on playback errors.
 *
 * The browser's player, and the desktop's fallback — see {@link playClip}.
 */
function playBlob(blob: Blob): Promise<void> {
	const url = URL.createObjectURL(blob);
	const audio = new Audio(url);
	const current = { stop: () => audio.pause() };
	playing = current;

	return new Promise<void>((resolve) => {
		const finish = (): void => {
			if (playing === current) playing = null;
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
 * Plays a WAV blob wherever this host can actually play one, resolving when it
 * finishes. Never rejects.
 *
 * In a browser that is an `<audio>` element and always has been. **On the
 * desktop it is the Rust host**, and the element path is only the fallback:
 * WebKitGTK builds a fresh GStreamer pipeline per clip, so `<audio>` starts
 * about a second late and stalls the window on every spoken word, and Web Audio
 * — the way to keep one pipeline for the session — plays noise or silence
 * there. So the clip goes back across the IPC and rodio plays it over one
 * output stream the host holds open (`crates/sapling-desktop/src/tts/play.rs`,
 * `docs/desktop.md`). This is the same {@link inTauri} decision as the engine
 * above, made in the same place for the same reason.
 *
 * The two failures are not the same failure. A host with **no output device**
 * will not have one later, so it is latched for the session and warned about
 * once; the element path still works there, slowly, which is better than
 * silence. A clip the host **refuses** is one bad clip and falls back alone.
 */
async function playClip(blob: Blob): Promise<void> {
	if (inTauri() && hostPlayback) {
		const host = await import('./native');
		const current = { stop: host.stopOnHost };
		try {
			const finished = host.playOnHost(blob);
			playing = current;
			await finished;
			return;
		} catch (cause) {
			if (cause instanceof host.NoAudioOutput) {
				hostPlayback = false;
				console.warn(
					'[tts] The desktop host has no audio output; falling back to the webview player.',
					cause
				);
			} else {
				console.warn('[tts] The host would not play that clip; playing it in the webview.', cause);
			}
		} finally {
			if (playing === current) playing = null;
		}
	}

	return playBlob(blob);
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
