/**
 * Speech preferences, stored the same way as everything in
 * `$lib/prefs`: plain `localStorage`, every accessor guarded so the module
 * imports cleanly in node (tests) and never throws in a private window.
 *
 * Kept in `$lib/tts` rather than `$lib/prefs` because the tts module reads
 * them on every `speak()` — the UI is just one more caller.
 */

const ENGINE_KEY = 'll.ttsEngine';
const VOICE_KEY = 'll.ttsVoice';

/**
 * Which speech backend to use. `off` silences the app entirely.
 *
 * `kokoro` has always meant "the good, downloaded, neural one" — it still
 * does, even though the runtime underneath changed from Transformers.js to
 * sherpa-onnx. Keeping the stored value means nobody's setting resets.
 */
export type TtsEngine = 'kokoro' | 'webspeech' | 'off';

/**
 * Which Mandarin voice to synthesize with. `auto` means "whatever the language
 * mapping picks" — see `languages.ts`, which also explains why English is not
 * part of this choice.
 */
export type TtsVoice = 'auto' | 'zf_001' | 'zf_018' | 'zm_010';

const ENGINES: readonly TtsEngine[] = ['kokoro', 'webspeech', 'off'];
const VOICES: readonly TtsVoice[] = ['auto', 'zf_001', 'zf_018', 'zm_010'];

export const DEFAULT_TTS_ENGINE: TtsEngine = 'kokoro';
export const DEFAULT_TTS_VOICE: TtsVoice = 'auto';

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

function read(key: string): string | null {
	if (!hasStorage()) return null;
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore: storage unavailable or full */
	}
}

/**
 * One stored enum preference: read it back if it is still a value we recognise,
 * otherwise report the default, and refuse to write anything off the list.
 */
function definePref<T extends string>(key: string, allowed: readonly T[], fallback: T) {
	return {
		get: (): T => {
			const raw = read(key);
			return allowed.includes(raw as T) ? (raw as T) : fallback;
		},
		set: (value: T): void => {
			if (!allowed.includes(value)) return;
			write(key, value);
		}
	};
}

const enginePref = definePref(ENGINE_KEY, ENGINES, DEFAULT_TTS_ENGINE);
const voicePref = definePref(VOICE_KEY, VOICES, DEFAULT_TTS_VOICE);

/** The chosen engine; anything unrecognised (or unset) reads as the default. */
export const getTtsEngine = enginePref.get;
export const setTtsEngine = enginePref.set;

/** The chosen Mandarin voice; unrecognised values read as the default. */
export const getTtsVoice = voicePref.get;
export const setTtsVoice = voicePref.set;
