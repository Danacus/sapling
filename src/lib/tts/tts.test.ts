/**
 * Which Kokoro speaks, which player plays it, and what those choices cost.
 *
 * `tts.ts` is mostly DOM, but the decisions that differ per host are pure:
 * given a window that looks like Tauri's, does the module reach for `native.ts`
 * instead of `sherpa.ts`, does it stop writing to the persistent clip cache,
 * and does it send the finished clip *back* to the host to be played instead of
 * building an `<audio>` element? All three are answerable in node, and all
 * three are the kind of thing that silently reverts.
 *
 * `warmSpeech` is the entry point for the synthesis half, because it takes the
 * same path down to synthesis and stops short of playing anything. The playback
 * half needs `speak`, and therefore needs a stand-in for the one browser API
 * that path touches — see {@link FakeAudio}, which is the assertion "an element
 * was built" as much as it is a stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sherpa = {
	initSherpa: vi.fn(async () => {}),
	onSherpaProgress: vi.fn(() => () => {}),
	synthesize: vi.fn(async () => new Blob(['browser']))
};

/** The host's "no output device at all", as `native.ts` defines it. */
class NoAudioOutput extends Error {}

/** What a host that *has* the voice answers `tts_status` with. */
const NATIVE_STATUS = {
	model: 'kokoro-multi-lang-v1_1',
	installed: true,
	bytes: 426654376,
	downloadBytes: 364816464,
	loaded: false
};

const native = {
	nativeKokoro: {
		init: vi.fn(async () => {}),
		onProgress: vi.fn(() => () => {}),
		synthesize: vi.fn(async () => new Blob(['native']))
	},
	nativeVoiceStatus: vi.fn(async () => NATIVE_STATUS),
	playOnHost: vi.fn(async (_clip: Blob) => {}),
	stopOnHost: vi.fn(() => {}),
	NoAudioOutput
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
 * The webview player, enough of it to tell whether one was built. Every clip
 * ends by itself on the next microtask, so `speak` resolves the way it does in
 * a browser; `pause()` fires `onpause`, which is the path a cut-off clip takes.
 */
class FakeAudio {
	static built: FakeAudio[] = [];
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onpause: (() => void) | null = null;
	paused = false;

	constructor(public readonly src: string) {
		FakeAudio.built.push(this);
	}

	play(): Promise<void> {
		queueMicrotask(() => {
			if (!this.paused) this.onended?.();
		});
		return Promise.resolve();
	}

	pause(): void {
		this.paused = true;
		this.onpause?.();
	}
}

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
	// `clearAllMocks` forgets the calls but keeps the implementations, and a
	// test that makes the host refuse a clip — or gives it no voice at all —
	// must not leak that into the next.
	native.playOnHost.mockReset();
	native.playOnHost.mockImplementation(async () => {});
	native.nativeVoiceStatus.mockReset();
	native.nativeVoiceStatus.mockImplementation(async () => NATIVE_STATUS);
	FakeAudio.built = [];
	Object.defineProperty(globalThis, 'Audio', {
		value: FakeAudio,
		configurable: true,
		writable: true
	});
});

afterEach(() => {
	// Leave node as node, or the next file inherits a fake window.
	Reflect.deleteProperty(globalThis, 'window');
	Reflect.deleteProperty(globalThis, 'Audio');
	vi.restoreAllMocks();
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

describe('a Tauri host with no voice of its own', () => {
	/**
	 * The Android build of the same shell: the five voice commands are compiled
	 * out, so every `invoke` of one rejects the way Tauri rejects an unknown
	 * command. `inTauri()` is still true — this is a fact about the host, not
	 * about the platform, which is why it is asked of the host.
	 */
	function voicelessHost(): void {
		pretendTauri();
		native.nativeVoiceStatus.mockRejectedValue(new Error('Command tts_status not found'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	}

	it('lets the browser voice speak instead of reaching for a command that is not there', async () => {
		voicelessHost();
		const { speak } = await loadTts();

		await speak('你好', MANDARIN);
		await speak('再见', MANDARIN);

		expect(native.nativeKokoro.synthesize).not.toHaveBeenCalled();
		// Nothing was synthesized, so nothing was played — by the host or by an
		// element. `speakWithWebSpeech` is what actually says the word.
		expect(native.playOnHost).not.toHaveBeenCalled();
		expect(FakeAudio.built).toHaveLength(0);
	});

	it('asks once and remembers the answer', async () => {
		voicelessHost();
		const { warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);
		await warmSpeech('再见', MANDARIN);

		expect(native.nativeVoiceStatus).toHaveBeenCalledTimes(1);
	});

	it('reports nothing to download rather than rejecting into Settings', async () => {
		voicelessHost();
		const { voiceDownloadBytes } = await loadTts();

		// Settings fires this off unawaited, so a rejection would be an unhandled
		// one on a screen the learner is already looking at.
		await expect(voiceDownloadBytes()).resolves.toBe(0);
	});

	it('fails an explicit preload with a reason, and never starts a download', async () => {
		voicelessHost();
		const { preloadKokoro } = await loadTts();

		await expect(preloadKokoro()).rejects.toThrow('no built-in voice');
		expect(native.nativeKokoro.init).not.toHaveBeenCalled();
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

describe('choosing the player', () => {
	it('builds an audio element in a browser', async () => {
		const { speak } = await loadTts();

		await speak('你好', MANDARIN);

		expect(FakeAudio.built).toHaveLength(1);
		expect(native.playOnHost).not.toHaveBeenCalled();
	});

	it('plays through the host inside Tauri, and builds no element at all', async () => {
		pretendTauri();
		const { speak } = await loadTts();

		await speak('你好', MANDARIN);

		expect(native.playOnHost).toHaveBeenCalledTimes(1);
		// The whole point: WebKitGTK's element path is a second of latency per
		// clip, so nothing may quietly build one alongside the host call.
		expect(FakeAudio.built).toHaveLength(0);
	});

	it('sends the host the clip that was synthesized', async () => {
		pretendTauri();
		const { speak } = await loadTts();

		await speak('你好', MANDARIN);

		const [clip] = native.playOnHost.mock.calls[0];
		expect(await clip.text()).toBe('native');
	});

	it('resolves only once the host says the clip has finished', async () => {
		pretendTauri();
		let finish = (): void => {};
		native.playOnHost.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const { speak } = await loadTts();

		let spoken = false;
		const speaking = speak('你好', MANDARIN).then(() => {
			spoken = true;
		});
		await vi.waitFor(() => expect(native.playOnHost).toHaveBeenCalledTimes(1));
		expect(spoken).toBe(false);

		finish();
		await speaking;
		expect(spoken).toBe(true);
	});
});

describe('when the host cannot play', () => {
	it('falls back to the element path and warns once, not once per word', async () => {
		pretendTauri();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		native.playOnHost.mockRejectedValue(new NoAudioOutput('no audio output device: none found'));
		const { speak } = await loadTts();

		await speak('你好', MANDARIN);
		await speak('再见', MANDARIN);

		// Latched: the second word never asks the host again.
		expect(native.playOnHost).toHaveBeenCalledTimes(1);
		expect(FakeAudio.built).toHaveLength(2);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('treats a refused clip as one clip, and keeps asking the host', async () => {
		pretendTauri();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		native.playOnHost.mockRejectedValueOnce(new Error('that clip is not a WAV file'));
		const { speak } = await loadTts();

		await speak('你好', MANDARIN);
		await speak('再见', MANDARIN);

		expect(native.playOnHost).toHaveBeenCalledTimes(2);
		// One element for the refused clip, none for the one that played.
		expect(FakeAudio.built).toHaveLength(1);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe('cutting off what is playing', () => {
	it('stops the host clip when a second phrase is spoken', async () => {
		pretendTauri();
		native.playOnHost.mockImplementationOnce(() => new Promise<void>(() => {}));
		const { speak } = await loadTts();

		void speak('你好', MANDARIN);
		// Let the first clip reach the host before the second one starts.
		await vi.waitFor(() => expect(native.playOnHost).toHaveBeenCalledTimes(1));
		await speak('再见', MANDARIN);

		expect(native.stopOnHost).toHaveBeenCalledTimes(1);
		expect(native.playOnHost).toHaveBeenCalledTimes(2);
	});

	it('stops the host clip on an explicit stopSpeaking', async () => {
		pretendTauri();
		native.playOnHost.mockImplementationOnce(() => new Promise<void>(() => {}));
		const { speak, stopSpeaking } = await loadTts();

		void speak('你好', MANDARIN);
		await vi.waitFor(() => expect(native.playOnHost).toHaveBeenCalledTimes(1));
		stopSpeaking();

		expect(native.stopOnHost).toHaveBeenCalledTimes(1);
	});

	it('never reaches for the host in a browser', async () => {
		const { speak, stopSpeaking } = await loadTts();

		await speak('你好', MANDARIN);
		stopSpeaking();

		expect(native.stopOnHost).not.toHaveBeenCalled();
		expect(FakeAudio.built[0].paused).toBe(false);
	});
});
