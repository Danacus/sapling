/**
 * Which Kokoro speaks, and what the choice costs.
 *
 * `tts.ts` is mostly DOM — playback, `Audio`, blob URLs — but the one decision
 * that now differs per host is pure: given a window that looks like Tauri's,
 * does the module reach for `native.ts` instead of `sherpa.ts`, and does it
 * stop writing to the persistent clip cache? Both are answerable in node, and
 * both are the kind of thing that silently reverts.
 *
 * `warmSpeech` is the entry point under test rather than `speak`, because it
 * takes the same path down to synthesis and stops short of playing anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sherpa = {
	initSherpa: vi.fn(async () => {}),
	onSherpaProgress: vi.fn(() => () => {}),
	synthesize: vi.fn(async () => new Blob(['browser']))
};

const native = {
	nativeKokoro: {
		init: vi.fn(async () => {}),
		onProgress: vi.fn(() => () => {}),
		synthesize: vi.fn(async () => new Blob(['native']))
	},
	nativeVoiceStatus: vi.fn(async () => ({
		model: 'kokoro-multi-lang-v1_1',
		installed: true,
		bytes: 426654376,
		downloadBytes: 364816464,
		loaded: false
	}))
};

const store = {
	readClip: vi.fn(async () => undefined),
	writeClip: vi.fn(async () => {}),
	audioCacheBytes: vi.fn(async () => 0),
	clearAudioCache: vi.fn(async () => {})
};

vi.mock('./sherpa', () => sherpa);
vi.mock('./native', () => native);
vi.mock('./audio-store', () => store);

/** The one language both engines are supposed to speak. */
const MANDARIN = 'Mandarin Chinese';
/** `zf_001`, the default Mandarin speaker — see `languages.ts`. */
const ZF_001 = 3;

/**
 * A window with Tauri's marker on it, which is the only thing `inTauri()`
 * looks at. Node has no `window` at all, so its absence is the web case.
 */
function pretendTauri(): void {
	Object.defineProperty(globalThis, 'window', {
		value: { __TAURI_INTERNALS__: {} },
		configurable: true,
		writable: true
	});
}

/** A fresh copy of the module, since the chosen provider is memoised. */
async function loadTts(): Promise<typeof import('./tts')> {
	vi.resetModules();
	return import('./tts');
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	// Leave node as node, or the next file inherits a fake window.
	Reflect.deleteProperty(globalThis, 'window');
});

describe('choosing the host that speaks Kokoro', () => {
	it('synthesizes through the browser worker when there is no Tauri host', async () => {
		const { warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);

		expect(sherpa.synthesize).toHaveBeenCalledWith('你好', ZF_001, 1);
		expect(native.nativeKokoro.synthesize).not.toHaveBeenCalled();
	});

	it('synthesizes through the native host inside Tauri', async () => {
		pretendTauri();
		const { warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);

		expect(native.nativeKokoro.synthesize).toHaveBeenCalledWith('你好', ZF_001, 1);
		expect(sherpa.synthesize).not.toHaveBeenCalled();
	});

	it('preloads through whichever host provides the model', async () => {
		const browser = await loadTts();
		await browser.preloadKokoro();
		expect(sherpa.initSherpa).toHaveBeenCalledTimes(1);
		expect(native.nativeKokoro.init).not.toHaveBeenCalled();

		pretendTauri();
		const desktop = await loadTts();
		await desktop.preloadKokoro();
		expect(native.nativeKokoro.init).toHaveBeenCalledTimes(1);
		// Still once, from the browser pass — the desktop never touched it.
		expect(sherpa.initSherpa).toHaveBeenCalledTimes(1);
	});

	it('subscribes progress to the host that is downloading', async () => {
		pretendTauri();
		const { preloadKokoro } = await loadTts();

		await preloadKokoro(() => {});

		expect(native.nativeKokoro.onProgress).toHaveBeenCalledTimes(1);
		expect(sherpa.onSherpaProgress).not.toHaveBeenCalled();
	});

	it('reports each host’s own first-run download size', async () => {
		const browser = await loadTts();
		// The two mirrored runtime files, from `models.ts`.
		expect(await browser.voiceDownloadBytes()).toBe(11903250 + 426654376);

		pretendTauri();
		const desktop = await loadTts();
		expect(await desktop.voiceDownloadBytes()).toBe(364816464);
	});
});

describe('the stored clip cache', () => {
	it('is read and written in a browser', async () => {
		const { warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);

		expect(store.readClip).toHaveBeenCalledTimes(1);
		expect(store.writeClip).toHaveBeenCalledTimes(1);
	});

	it('is skipped on the desktop, where re-synthesis is cheaper', async () => {
		pretendTauri();
		const { warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);

		expect(store.readClip).not.toHaveBeenCalled();
		expect(store.writeClip).not.toHaveBeenCalled();
	});

	it('still dedupes replays in memory on the desktop', async () => {
		pretendTauri();
		const { warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);
		await warmSpeech('你好', MANDARIN);

		expect(native.nativeKokoro.synthesize).toHaveBeenCalledTimes(1);
	});
});
