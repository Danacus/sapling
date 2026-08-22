/**
 * Speech preferences, stored the same way as everything in
 * `$lib/ui/prefs`: plain `localStorage`, every accessor guarded so the module
 * imports cleanly in node (tests) and never throws in a private window.
 *
 * Kept in `$lib/tts` rather than `$lib/ui/prefs` because the tts module reads
 * them on every `speak()` — the UI is just one more caller.
 */

const ENGINE_KEY = 'll.ttsEngine';
const DEVICE_KEY = 'll.ttsDevice';
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
 * **Vestigial.** Kokoro used to be able to run on WebGPU; sherpa-onnx's WASM
 * build is CPU-only, so nothing reads this any more. The accessors stay so an
 * existing `ll.ttsDevice` value is still readable (and harmless) rather than
 * being silently reinterpreted if a device choice ever comes back.
 */
export type TtsDevice = 'auto' | 'wasm';

/**
 * Which Mandarin voice to synthesize with. `auto` means "whatever the language
 * mapping picks" — see `languages.ts`, which also explains why English is not
 * part of this choice.
 */
export type TtsVoice = 'auto' | 'zf_001' | 'zf_018' | 'zm_010';

const ENGINES: readonly TtsEngine[] = ['kokoro', 'webspeech', 'off'];
const DEVICES: readonly TtsDevice[] = ['auto', 'wasm'];
const VOICES: readonly TtsVoice[] = ['auto', 'zf_001', 'zf_018', 'zm_010'];

export const DEFAULT_TTS_ENGINE: TtsEngine = 'kokoro';
export const DEFAULT_TTS_DEVICE: TtsDevice = 'auto';
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

/** The chosen engine; anything unrecognised (or unset) reads as the default. */
export function getTtsEngine(): TtsEngine {
	const raw = read(ENGINE_KEY);
	return ENGINES.includes(raw as TtsEngine) ? (raw as TtsEngine) : DEFAULT_TTS_ENGINE;
}

export function setTtsEngine(engine: TtsEngine): void {
	if (!ENGINES.includes(engine)) return;
	write(ENGINE_KEY, engine);
}

/** Legacy device preference; unrecognised values read as the default. */
export function getTtsDevice(): TtsDevice {
	const raw = read(DEVICE_KEY);
	return DEVICES.includes(raw as TtsDevice) ? (raw as TtsDevice) : DEFAULT_TTS_DEVICE;
}

export function setTtsDevice(device: TtsDevice): void {
	if (!DEVICES.includes(device)) return;
	write(DEVICE_KEY, device);
}

/** The chosen Mandarin voice; unrecognised values read as the default. */
export function getTtsVoice(): TtsVoice {
	const raw = read(VOICE_KEY);
	return VOICES.includes(raw as TtsVoice) ? (raw as TtsVoice) : DEFAULT_TTS_VOICE;
}

export function setTtsVoice(voice: TtsVoice): void {
	if (!VOICES.includes(voice)) return;
	write(VOICE_KEY, voice);
}
