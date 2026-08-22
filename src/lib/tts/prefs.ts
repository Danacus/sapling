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

/** Which speech backend to use. `off` silences the app entirely. */
export type TtsEngine = 'kokoro' | 'webspeech' | 'off';

/**
 * Where Kokoro runs. `auto` picks WebGPU when the browser exposes it and
 * falls back to WASM; `wasm` forces the CPU path, which is slower but is the
 * escape hatch for browsers whose WebGPU produces garbled audio (Firefox on
 * Linux, notably).
 */
export type TtsDevice = 'auto' | 'wasm';

const ENGINES: readonly TtsEngine[] = ['kokoro', 'webspeech', 'off'];
const DEVICES: readonly TtsDevice[] = ['auto', 'wasm'];

export const DEFAULT_TTS_ENGINE: TtsEngine = 'kokoro';
export const DEFAULT_TTS_DEVICE: TtsDevice = 'auto';

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

/** Where Kokoro should run; unrecognised values read as the default. */
export function getTtsDevice(): TtsDevice {
	const raw = read(DEVICE_KEY);
	return DEVICES.includes(raw as TtsDevice) ? (raw as TtsDevice) : DEFAULT_TTS_DEVICE;
}

export function setTtsDevice(device: TtsDevice): void {
	if (!DEVICES.includes(device)) return;
	write(DEVICE_KEY, device);
}
