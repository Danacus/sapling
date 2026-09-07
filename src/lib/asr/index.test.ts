/**
 * Which backend dictates, and for whom.
 *
 * There are two engines now and the choice between them is not a platform
 * question: a Tauri host recognizes exactly the languages its own model covers,
 * a browser has Web Speech or has nothing, and a shell built without the
 * feature has no `asr_status` at all. All three are the same shape of mistake
 * to get wrong — a microphone button that does nothing, or one that is missing
 * where it would have worked — and none of them would fail loudly.
 *
 * `listen` is synchronous by contract, so the whole routing question is
 * answered off a *settled* probe that `dictationAvailable` warmed. That
 * ordering is the other thing pinned here: it is invisible until the day
 * someone calls `listen` without ever having asked whether to draw the button.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = {
	nativeAsrStatus: vi.fn(async () => NATIVE_STATUS),
	dictateNatively: vi.fn((_handlers: unknown) => ({ stop: vi.fn(), abort: vi.fn() })),
	installAsrModel: vi.fn(async () => {}),
	onAsrProgress: vi.fn(() => () => {})
};

vi.mock('./native', () => native);

/** What a host with the model downloaded answers. */
const NATIVE_STATUS = {
	model: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
	installed: true,
	bytes: 240_506_435,
	downloadBytes: 163_002_883,
	loaded: false,
	languages: ['zh', 'en', 'ja', 'ko', 'yue']
};

/** The same host before the learner has downloaded anything. */
const NOT_DOWNLOADED = { ...NATIVE_STATUS, installed: false, bytes: 0 };

/** A minimal `SpeechRecognition`, enough to be detected and started. */
class FakeRecognition {
	static built = 0;
	lang = '';
	continuous = false;
	interimResults = false;
	maxAlternatives = 0;
	onresult: unknown = null;
	onerror: unknown = null;
	onend: (() => void) | null = null;

	constructor() {
		FakeRecognition.built += 1;
	}

	start(): void {}
	stop(): void {}
	abort(): void {}
}

/**
 * A window with Tauri's marker on it, which is the only thing `inTauri()` looks
 * at. Node has no `window` at all, so its absence is the web case.
 */
function pretendTauri(): void {
	Object.defineProperty(globalThis, 'window', {
		value: { __TAURI_INTERNALS__: {} },
		configurable: true,
		writable: true
	});
}

/** A browser that has the Web Speech API. Chrome; never WebKitGTK or Firefox. */
function pretendWebSpeech(): void {
	Object.defineProperty(globalThis, 'SpeechRecognition', {
		value: FakeRecognition,
		configurable: true,
		writable: true
	});
}

/** A fresh copy of the router, since the host probe is memoised. */
async function loadAsr(): Promise<typeof import('./index')> {
	vi.resetModules();
	return import('./index');
}

const handlers = { onTranscript: vi.fn(), onEnd: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	native.nativeAsrStatus.mockReset();
	native.nativeAsrStatus.mockImplementation(async () => NATIVE_STATUS);
	FakeRecognition.built = 0;
});

afterEach(() => {
	// Leave node as node, or the next file inherits a fake window.
	Reflect.deleteProperty(globalThis, 'window');
	Reflect.deleteProperty(globalThis, 'SpeechRecognition');
	vi.restoreAllMocks();
});

describe('a browser', () => {
	it('never asks a host that is not there', async () => {
		pretendWebSpeech();
		const { dictationAvailable } = await loadAsr();

		await expect(dictationAvailable('Mandarin Chinese')).resolves.toBe(true);
		expect(native.nativeAsrStatus).not.toHaveBeenCalled();
	});

	it('dictates through Web Speech, in every language it has one for', async () => {
		pretendWebSpeech();
		const { dictationAvailable, listen } = await loadAsr();
		await dictationAvailable('Mandarin Chinese');

		expect(listen('Mandarin Chinese', handlers)).toBeDefined();
		expect(FakeRecognition.built).toBe(1);
		expect(native.dictateNatively).not.toHaveBeenCalled();
	});

	it('offers nothing where the browser has no recognizer — Firefox', async () => {
		const { dictationAvailable, listen } = await loadAsr();

		await expect(dictationAvailable('Mandarin Chinese')).resolves.toBe(false);
		// `undefined` is the whole of the failure: no handler will ever fire.
		expect(listen('Mandarin Chinese', handlers)).toBeUndefined();
	});

	it('has nothing to download', async () => {
		const { dictationDownloadBytes, dictationModelInstalled } = await loadAsr();

		await expect(dictationDownloadBytes()).resolves.toBe(0);
		await expect(dictationModelInstalled()).resolves.toBe(false);
	});
});

describe('a Tauri host with the model downloaded', () => {
	it('dictates natively in a language the model covers', async () => {
		pretendTauri();
		const { dictationAvailable, listen } = await loadAsr();

		await expect(dictationAvailable('Mandarin Chinese')).resolves.toBe(true);
		expect(listen('Mandarin Chinese', handlers)).toBeDefined();
		expect(native.dictateNatively).toHaveBeenCalledTimes(1);
	});

	it('matches on the primary subtag, so a script or a region still counts', async () => {
		pretendTauri();
		const { dictationAvailable } = await loadAsr();

		// `zh-CN`, `zh-Hans` and `zh-TW` all resolve to a `zh` the model reads.
		await expect(dictationAvailable('Chinese')).resolves.toBe(true);
		await expect(dictationAvailable('Simplified Chinese')).resolves.toBe(true);
		await expect(dictationAvailable('Traditional Chinese')).resolves.toBe(true);
		await expect(dictationAvailable('Japanese')).resolves.toBe(true);
		await expect(dictationAvailable('Korean')).resolves.toBe(true);
	});

	it('treats Cantonese as its own language, the way the voice does', async () => {
		pretendTauri();
		native.nativeAsrStatus.mockResolvedValue({ ...NATIVE_STATUS, languages: ['zh', 'en'] });
		const { dictationAvailable } = await loadAsr();

		// `yue` is in the model's list or it is not; it is never a kind of `zh`.
		await expect(dictationAvailable('Cantonese')).resolves.toBe(false);
		await expect(dictationAvailable('Mandarin')).resolves.toBe(true);
	});

	it('offers nothing for a language the model does not cover', async () => {
		pretendTauri();
		const { dictationAvailable, listen } = await loadAsr();

		// No Web Speech in either Tauri webview, so this is genuinely no button.
		await expect(dictationAvailable('Dutch')).resolves.toBe(false);
		expect(listen('Dutch', handlers)).toBeUndefined();
		expect(native.dictateNatively).not.toHaveBeenCalled();
	});

	it('says what a covered language costs and that it is already here', async () => {
		pretendTauri();
		const { dictationDownloadBytes, dictationModelInstalled, dictationCoversLanguage } =
			await loadAsr();

		await expect(dictationDownloadBytes()).resolves.toBe(163_002_883);
		await expect(dictationModelInstalled()).resolves.toBe(true);
		await expect(dictationCoversLanguage('Japanese')).resolves.toBe(true);
		await expect(dictationCoversLanguage('Dutch')).resolves.toBe(false);
	});

	it('asks once and remembers the answer', async () => {
		pretendTauri();
		const { dictationAvailable, dictationDownloadBytes } = await loadAsr();

		await dictationAvailable('Mandarin Chinese');
		await dictationAvailable('Japanese');
		await dictationDownloadBytes();

		expect(native.nativeAsrStatus).toHaveBeenCalledTimes(1);
	});
});

describe('a Tauri host that has not downloaded the model', () => {
	it('offers no microphone, but does say what it would cost', async () => {
		pretendTauri();
		native.nativeAsrStatus.mockResolvedValue(NOT_DOWNLOADED);
		const { dictationAvailable, dictationDownloadBytes, dictationCoversLanguage } = await loadAsr();

		await expect(dictationAvailable('Mandarin Chinese')).resolves.toBe(false);
		// Settings must still be able to offer the download, and must still be
		// able to warn a Dutch learner that downloading it would change nothing.
		await expect(dictationDownloadBytes()).resolves.toBe(163_002_883);
		await expect(dictationCoversLanguage('Mandarin Chinese')).resolves.toBe(true);
	});

	it('starts routing natively the moment the download finishes', async () => {
		pretendTauri();
		native.nativeAsrStatus.mockResolvedValue({ ...NOT_DOWNLOADED });
		const { dictationAvailable, listen, preloadDictationModel } = await loadAsr();
		await dictationAvailable('Mandarin Chinese');
		expect(listen('Mandarin Chinese', handlers)).toBeUndefined();

		await preloadDictationModel();

		// Without this the button would stay hidden until the page next mounted,
		// on the one screen where the learner has just been told it is ready.
		await expect(dictationAvailable('Mandarin Chinese')).resolves.toBe(true);
		expect(listen('Mandarin Chinese', handlers)).toBeDefined();
		expect(native.nativeAsrStatus).toHaveBeenCalledTimes(1);
	});

	it('subscribes a progress listener for the length of the install and no longer', async () => {
		pretendTauri();
		const unsubscribe = vi.fn();
		native.onAsrProgress.mockReturnValue(unsubscribe);
		const { preloadDictationModel } = await loadAsr();

		await preloadDictationModel(() => {});

		expect(native.onAsrProgress).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('unsubscribes even when the install fails', async () => {
		pretendTauri();
		const unsubscribe = vi.fn();
		native.onAsrProgress.mockReturnValue(unsubscribe);
		native.installAsrModel.mockRejectedValueOnce(new Error('the download stopped early'));
		const { preloadDictationModel } = await loadAsr();

		await expect(preloadDictationModel(() => {})).rejects.toThrow('stopped early');
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe('a Tauri host with no recognizer at all', () => {
	/**
	 * A shell built with its `speech` feature off: `asr_status` is not a
	 * registered command, so the `invoke` rejects the way Tauri rejects any
	 * unknown one. A fact about the build, not about the platform — which is why
	 * it is asked of the host.
	 */
	function recognizerlessHost(): void {
		pretendTauri();
		native.nativeAsrStatus.mockRejectedValue(new Error('Command asr_status not found'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	}

	it('falls back to whatever the webview has, which here is nothing', async () => {
		recognizerlessHost();
		const { dictationAvailable, listen } = await loadAsr();

		await expect(dictationAvailable('Mandarin Chinese')).resolves.toBe(false);
		expect(listen('Mandarin Chinese', handlers)).toBeUndefined();
	});

	it('reports nothing to download rather than rejecting into Settings', async () => {
		recognizerlessHost();
		const { dictationDownloadBytes } = await loadAsr();

		// Settings fires this off unawaited, so a rejection would be an unhandled
		// one on a screen the learner is already looking at.
		await expect(dictationDownloadBytes()).resolves.toBe(0);
	});

	it('fails an explicit download with a reason, and never starts one', async () => {
		recognizerlessHost();
		const { preloadDictationModel } = await loadAsr();

		await expect(preloadDictationModel()).rejects.toThrow('no recognizer');
		expect(native.installAsrModel).not.toHaveBeenCalled();
	});

	it('warns once, however many times it is asked', async () => {
		recognizerlessHost();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { dictationAvailable } = await loadAsr();

		await dictationAvailable('Mandarin Chinese');
		await dictationAvailable('Japanese');

		expect(warn).toHaveBeenCalledTimes(1);
		expect(native.nativeAsrStatus).toHaveBeenCalledTimes(1);
	});
});

describe('listen without the probe', () => {
	it('takes the browser engine, because the host has not answered yet', async () => {
		// The documented consequence of `listen` being synchronous. A caller that
		// renders the microphone on `dictationAvailable`'s answer has already
		// warmed the probe by the time anyone can press it; one that did not gets
		// the engine that needs no asking.
		pretendTauri();
		pretendWebSpeech();
		const { listen } = await loadAsr();

		expect(listen('Mandarin Chinese', handlers)).toBeDefined();
		expect(native.dictateNatively).not.toHaveBeenCalled();
		expect(FakeRecognition.built).toBe(1);
	});
});
