/**
 * Which Kokoro speaks, how the clip is played, and what each choice costs.
 *
 * `tts.ts` is mostly DOM, but every decision that differs per host is a plain
 * branch: given a window that looks like Tauri's, does the module reach for
 * `native.ts` instead of `sherpa.ts`, does it stop writing to the persistent
 * clip cache, and does it play through the Web Audio graph rather than an
 * `<audio>` element? All three are answerable in node against fakes, and all
 * three are the kind of thing that silently reverts.
 *
 * `warmSpeech` is the entry point for the first two rather than `speak`,
 * because it takes the same path down to synthesis and stops short of playing
 * anything.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeWav } from './wav';

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
	Reflect.deleteProperty(globalThis, 'AudioContext');
	Reflect.deleteProperty(globalThis, 'Audio');
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

// -- Playing it --------------------------------------------------------------

/**
 * Web Audio reduced to what `tts.ts` touches: a context that can be built (or
 * refuse to be), a buffer that can be filled, and a source that announces its
 * own end. Nothing here makes a sound — what is under test is which calls
 * happen, and how many contexts they cost.
 */
class FakeBuffer {
	channel: Float32Array | null = null;

	constructor(
		readonly channels: number,
		readonly length: number,
		readonly sampleRate: number
	) {}

	copyToChannel(samples: Float32Array): void {
		this.channel = samples;
	}
}

class FakeSource {
	buffer: FakeBuffer | null = null;
	onended: (() => void) | null = null;
	started = false;

	connect(): void {}

	start(): void {
		this.started = true;
	}

	/** Like the real node: stopping one that is running still raises `ended`. */
	stop(): void {
		this.onended?.();
	}
}

class FakeContext {
	static built = 0;
	static last: FakeContext | undefined;
	static buffers: FakeBuffer[] = [];
	static sources: FakeSource[] = [];
	/** A WebKitGTK with no GStreamer plugins, minus the process death. */
	static broken = false;
	/** Parked on arrival, the way an autoplay policy would leave it. */
	static startsSuspended = false;

	state: 'suspended' | 'running';
	resumes = 0;
	readonly destination = {};

	constructor() {
		if (FakeContext.broken) throw new Error('no audio device');
		this.state = FakeContext.startsSuspended ? 'suspended' : 'running';
		FakeContext.built++;
		FakeContext.last = this;
	}

	async resume(): Promise<void> {
		this.resumes++;
		this.state = 'running';
	}

	createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
		const buffer = new FakeBuffer(channels, length, sampleRate);
		FakeContext.buffers.push(buffer);
		return buffer;
	}

	createBufferSource(): FakeSource {
		const source = new FakeSource();
		FakeContext.sources.push(source);
		return source;
	}
}

/** The element path's half of the same trick. */
class FakeAudio {
	static made: FakeAudio[] = [];
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onpause: (() => void) | null = null;

	constructor(readonly src: string) {
		FakeAudio.made.push(this);
	}

	play(): Promise<void> {
		return Promise.resolve();
	}

	pause(): void {
		this.onpause?.();
	}
}

/** A real 16 kHz WAV, because the desktop path parses what it is handed. */
const CLIP_FRAMES = 400;
const CLIP_RATE = 16000;
const clipBlob = (): Blob =>
	new Blob([
		encodeWav(
			Float32Array.from({ length: CLIP_FRAMES }, (_, i) => Math.sin(i / 8)),
			CLIP_RATE
		)
	]);

describe('playing a clip', () => {
	let warned: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		FakeContext.built = 0;
		FakeContext.last = undefined;
		FakeContext.buffers = [];
		FakeContext.sources = [];
		FakeContext.broken = false;
		FakeContext.startsSuspended = false;
		FakeAudio.made = [];

		globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
		globalThis.Audio = FakeAudio as unknown as typeof Audio;

		native.nativeKokoro.synthesize.mockResolvedValue(clipBlob());
		sherpa.synthesize.mockResolvedValue(clipBlob());
		warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warned.mockRestore();
	});

	/** The nth source node, once the awaits between `speak` and it have run. */
	async function source(index: number): Promise<FakeSource> {
		await vi.waitFor(() => expect(FakeContext.sources.length).toBeGreaterThan(index));
		return FakeContext.sources[index];
	}

	/** The nth `<audio>`, likewise. */
	async function element(index: number): Promise<FakeAudio> {
		await vi.waitFor(() => expect(FakeAudio.made.length).toBeGreaterThan(index));
		return FakeAudio.made[index];
	}

	it('builds no context until something actually plays', async () => {
		pretendTauri();
		const { speak, warmSpeech } = await loadTts();

		await warmSpeech('你好', MANDARIN);
		expect(FakeContext.built).toBe(0);

		const spoken = speak('你好', MANDARIN);
		(await source(0)).onended?.();
		await spoken;

		expect(FakeContext.built).toBe(1);
	});

	it('plays every clip through that one context, and never through an element', async () => {
		pretendTauri();
		const { speak } = await loadTts();

		const first = speak('你好', MANDARIN);
		(await source(0)).onended?.();
		await first;

		const second = speak('再见', MANDARIN);
		(await source(1)).onended?.();
		await second;

		expect(FakeContext.built).toBe(1);
		expect(FakeContext.sources[1].started).toBe(true);
		expect(FakeAudio.made).toHaveLength(0);
	});

	it('fills a mono buffer at the clip’s own rate and lets the context resample', async () => {
		pretendTauri();
		const { speak } = await loadTts();

		const spoken = speak('你好', MANDARIN);
		(await source(0)).onended?.();
		await spoken;

		expect(FakeContext.buffers).toHaveLength(1);
		expect(FakeContext.buffers[0].channels).toBe(1);
		expect(FakeContext.buffers[0].length).toBe(CLIP_FRAMES);
		expect(FakeContext.buffers[0].sampleRate).toBe(CLIP_RATE);
		expect(FakeContext.buffers[0].channel).toHaveLength(CLIP_FRAMES);
	});

	it('resumes a context that arrives suspended', async () => {
		FakeContext.startsSuspended = true;
		pretendTauri();
		const { speak } = await loadTts();

		const spoken = speak('你好', MANDARIN);
		(await source(0)).onended?.();
		await spoken;

		expect(FakeContext.last?.resumes).toBe(1);
	});

	it('lets a second call cut the first off, and still resolves the first', async () => {
		pretendTauri();
		const { speak } = await loadTts();

		const first = speak('你好', MANDARIN);
		await source(0);

		const second = speak('再见', MANDARIN);
		await expect(first).resolves.toBeUndefined();

		(await source(1)).onended?.();
		await second;
	});

	it('resolves the promise when stopSpeaking cuts the source off', async () => {
		pretendTauri();
		const { speak, stopSpeaking } = await loadTts();

		const spoken = speak('你好', MANDARIN);
		await source(0);
		stopSpeaking();

		await expect(spoken).resolves.toBeUndefined();
	});

	it('falls back to the element path when the context cannot be built, warning once', async () => {
		FakeContext.broken = true;
		pretendTauri();
		const { speak } = await loadTts();

		const first = speak('你好', MANDARIN);
		(await element(0)).onended?.();
		await first;

		const second = speak('再见', MANDARIN);
		(await element(1)).onended?.();
		await second;

		expect(FakeContext.sources).toHaveLength(0);
		expect(warned).toHaveBeenCalledTimes(1);
		expect(String(warned.mock.calls[0][0])).toMatch(/Web Audio is unavailable/);
	});

	it('keeps the element path in a browser, where it was never the problem', async () => {
		const { speak } = await loadTts();

		const spoken = speak('你好', MANDARIN);
		(await element(0)).onended?.();
		await spoken;

		expect(FakeContext.built).toBe(0);
		expect(warned).not.toHaveBeenCalled();
	});
});
