/**
 * The native dictation session, and the one promise it has to keep on every
 * path: **`onEnd` exactly once.**
 *
 * `listen`'s contract is small and unforgiving — `undefined` means no handler
 * will ever fire, and a returned session ends once, silently unless the learner
 * can do something about it. The Web Speech backend gets that almost for free
 * from one `onend` event; this one has to assemble it out of an asynchronous
 * permission prompt, a worklet that may not load, a stop button, an abort, and
 * a host call that can be rejected — five ways in and one way out. So the
 * assertion in nearly every test below is a call count.
 *
 * The browser side is faked rather than mocked away: `getUserMedia`, an
 * `AudioContext` and an `AudioWorkletNode` that can be told to post quanta, so
 * the module's own capture code runs and the fakes are also the assertion that
 * the device was released.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TARGET_SAMPLE_RATE } from './pcm';

const invoke = vi.fn(async (_command: string, _payload?: unknown) => 'ok' as unknown);
const listen = vi.fn(async () => () => {});

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('$app/paths', () => ({ base: '' }));

class FakeTrack {
	stopped = false;
	stop(): void {
		this.stopped = true;
	}
}

class FakeStream {
	readonly tracks = [new FakeTrack()];
	getTracks(): FakeTrack[] {
		return this.tracks;
	}
}

/** The node the worklet runs in; `emit` is the worklet posting one quantum. */
class FakeWorkletNode {
	static last: FakeWorkletNode | undefined;
	readonly port: { onmessage: ((event: { data: Float32Array }) => void) | null } = {
		onmessage: null
	};

	constructor(
		_context: unknown,
		readonly name: string,
		readonly options: { numberOfInputs?: number; numberOfOutputs?: number }
	) {
		FakeWorkletNode.last = this;
	}

	emit(samples: Float32Array): void {
		this.port.onmessage?.({ data: samples });
	}
}

class FakeAudioContext {
	static built: FakeAudioContext[] = [];
	/** A browser that will not open a context at a rate you name. */
	static refuseRate = false;
	/** A worklet file that will not load — a 404, or a host with no `static/`. */
	static refuseWorklet = false;

	readonly sampleRate: number;
	closed = false;
	disconnected = 0;
	readonly audioWorklet = {
		addModule: vi.fn(async (_url: string) => {
			if (FakeAudioContext.refuseWorklet) throw new Error('404');
		})
	};

	constructor(options?: { sampleRate?: number }) {
		if (options?.sampleRate !== undefined && FakeAudioContext.refuseRate) {
			throw new Error('NotSupportedError');
		}
		this.sampleRate = options?.sampleRate ?? 48_000;
		FakeAudioContext.built.push(this);
	}

	createMediaStreamSource(): { connect(): void; disconnect(): void } {
		return { connect: () => {}, disconnect: () => (this.disconnected += 1) };
	}

	close(): Promise<void> {
		this.closed = true;
		return Promise.resolve();
	}
}

let stream: FakeStream;
const getUserMedia = vi.fn(async (_constraints: unknown) => stream);

/** A window that can record: what `captureAvailable` looks for, plus the fakes. */
function pretendMicrophone(): void {
	stream = new FakeStream();
	Object.defineProperty(globalThis, 'navigator', {
		value: { mediaDevices: { getUserMedia } },
		configurable: true,
		writable: true
	});
	Object.defineProperty(globalThis, 'AudioContext', {
		value: FakeAudioContext,
		configurable: true,
		writable: true
	});
	Object.defineProperty(globalThis, 'AudioWorkletNode', {
		value: FakeWorkletNode,
		configurable: true,
		writable: true
	});
}

/** A fresh copy of the module, since the Tauri import is memoised. */
async function loadNative(): Promise<typeof import('./native')> {
	vi.resetModules();
	return import('./native');
}

/** A run of samples loud enough and long enough to be an utterance. */
function speech(seconds = 1, rate = TARGET_SAMPLE_RATE): Float32Array {
	const samples = new Float32Array(Math.round(seconds * rate));
	for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin(i / 8);
	return samples;
}

/**
 * Lets the module's own asynchrony finish — the permission prompt, the dynamic
 * `@tauri-apps/api` import, the transcription. Macrotask turns rather than
 * microtasks, because a dynamic import is not resolved by draining the
 * microtask queue.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	invoke.mockReset();
	invoke.mockImplementation(async () => 'ok');
	FakeAudioContext.built = [];
	FakeAudioContext.refuseRate = false;
	FakeAudioContext.refuseWorklet = false;
	FakeWorkletNode.last = undefined;
	getUserMedia.mockReset();
	getUserMedia.mockImplementation(async () => stream);
	pretendMicrophone();
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, 'navigator');
	Reflect.deleteProperty(globalThis, 'AudioContext');
	Reflect.deleteProperty(globalThis, 'AudioWorkletNode');
	vi.restoreAllMocks();
});

describe('starting at all', () => {
	it('answers undefined where there is no microphone API, and fires nothing', async () => {
		Reflect.deleteProperty(globalThis, 'navigator');
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();

		expect(session).toBeUndefined();
		expect(onEnd).not.toHaveBeenCalled();
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it('never connects the capture graph to an output device', async () => {
		const { dictateNatively } = await loadNative();

		dictateNatively({ onTranscript: vi.fn(), onEnd: vi.fn() });
		await settle();

		// The whole reason the worklet has no output: on the desktop host, Web
		// Audio *output* plays noise or silence, and a recorder that had to
		// reach the speakers could make a sound while the learner is talking.
		expect(FakeWorkletNode.last?.options.numberOfOutputs).toBe(0);
		expect(FakeWorkletNode.last?.name).toBe('pcm-collector');
	});

	it('asks the browser to open at the rate the recognizer reads', async () => {
		const { dictateNatively } = await loadNative();

		dictateNatively({ onTranscript: vi.fn(), onEnd: vi.fn() });
		await settle();

		expect(FakeAudioContext.built[0].sampleRate).toBe(TARGET_SAMPLE_RATE);
	});

	it('takes the device rate when the browser refuses that option', async () => {
		FakeAudioContext.refuseRate = true;
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech(1, 48_000));
		session?.stop();
		await settle();

		expect(FakeAudioContext.built[0].sampleRate).toBe(48_000);
		// One second at 48 kHz, resampled: the host is handed 16 kHz either way.
		const [, pcm] = invoke.mock.calls[0];
		expect((pcm as Uint8Array).byteLength).toBe(TARGET_SAMPLE_RATE * 2);
		expect(onEnd).toHaveBeenCalledTimes(1);
	});
});

describe('one utterance, stopped by the learner', () => {
	it('transcribes once, finally, and ends silently', async () => {
		invoke.mockResolvedValue('  你好世界。 ');
		const onTranscript = vi.fn();
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript, onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		await settle();

		expect(onTranscript).toHaveBeenCalledExactlyOnceWith('你好世界。', true);
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it('sends the audio as a raw body and not as JSON', async () => {
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd: vi.fn() });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		await settle();

		const [command, pcm] = invoke.mock.calls[0];
		expect(command).toBe('asr_transcribe');
		// A `Uint8Array` is what makes Tauri treat the payload as `InvokeBody::Raw`;
		// an array of numbers here would be megabytes of decimal digits.
		expect(pcm).toBeInstanceOf(Uint8Array);
		expect((pcm as Uint8Array).byteLength).toBe(TARGET_SAMPLE_RATE * 2);
	});

	it('releases the microphone and the context', async () => {
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd: vi.fn() });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		await settle();

		expect(stream.tracks[0].stopped).toBe(true);
		expect(FakeAudioContext.built[0].closed).toBe(true);
		expect(FakeAudioContext.built[0].disconnected).toBe(1);
	});

	it('ends once however many times the learner presses stop', async () => {
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		session?.stop();
		await settle();
		session?.stop();
		await settle();

		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledTimes(1);
	});
});

describe('the paths that produce no transcript', () => {
	it('ends silently when the host rejects the transcription', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		invoke.mockRejectedValue(new Error('the dictation model is not downloaded yet'));
		const onTranscript = vi.fn();
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript, onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		await settle();

		expect(onTranscript).not.toHaveBeenCalled();
		// Silent: a host that would not transcribe is not something the learner
		// can fix, and the composer they were about to type into still works.
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(stream.tracks[0].stopped).toBe(true);
	});

	it('says nothing about an utterance the model answered with nothing', async () => {
		invoke.mockResolvedValue('   ');
		const onTranscript = vi.fn();
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript, onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		await settle();

		expect(onTranscript).not.toHaveBeenCalled();
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it('never asks the host about a microphone that heard nothing', async () => {
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();
		// Opened and closed again without a word: the gate in `pcm.ts` catches
		// it, because the model would have answered with a filler.
		session?.stop();
		await settle();

		expect(invoke).not.toHaveBeenCalled();
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it('drops what it heard on abort, and asks nothing', async () => {
		const onTranscript = vi.fn();
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript, onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.abort();
		await settle();

		expect(invoke).not.toHaveBeenCalled();
		expect(onTranscript).not.toHaveBeenCalled();
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(stream.tracks[0].stopped).toBe(true);
	});

	it('ends once when an abort follows a stop', async () => {
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();
		FakeWorkletNode.last?.emit(speech());
		session?.stop();
		session?.abort();
		await settle();

		expect(onEnd).toHaveBeenCalledTimes(1);
	});
});

describe('a microphone that will not open', () => {
	it('tells the learner about a permission they can grant', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const refusal = new Error('Permission denied');
		refusal.name = 'NotAllowedError';
		getUserMedia.mockRejectedValue(refusal);
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();

		// `micErrorMessage`'s own words, so the two backends cannot word the
		// same problem two ways.
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(
			'Microphone access is blocked. Allow it in your browser settings to dictate.'
		);
	});

	it('tells them about a device that is not there', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const missing = new Error('Requested device not found');
		missing.name = 'NotFoundError';
		getUserMedia.mockRejectedValue(missing);
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();

		expect(onEnd).toHaveBeenCalledExactlyOnceWith('No microphone found.');
	});

	it('says nothing about a failure the learner cannot act on, and still ends', async () => {
		// A worklet that would not load: the device was granted, so it has to be
		// handed back, and there is nothing useful to tell anyone.
		FakeAudioContext.refuseWorklet = true;
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		dictateNatively({ onTranscript: vi.fn(), onEnd });
		await settle();

		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(stream.tracks[0].stopped).toBe(true);
	});
});

describe('the learner is faster than the permission prompt', () => {
	/** A `getUserMedia` that does not resolve until it is told to. */
	function slowPrompt(): () => void {
		let allow = (): void => {};
		getUserMedia.mockImplementation(
			() =>
				new Promise((resolve) => {
					allow = () => resolve(stream);
				})
		);
		return () => allow();
	}

	it('transcribes a stop that arrived while the mic was still opening', async () => {
		invoke.mockResolvedValue('早安。');
		const grant = slowPrompt();
		const onTranscript = vi.fn();
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript, onEnd });
		session?.stop();
		grant();
		await settle();

		// Nothing was captured — the microphone opened after the stop — so this
		// is the silent path, and the one thing that must not happen is a
		// session left open with a device held and no `onEnd`.
		expect(onEnd).toHaveBeenCalledExactlyOnceWith(undefined);
		expect(onTranscript).not.toHaveBeenCalled();
		expect(stream.tracks[0].stopped).toBe(true);
	});

	it('releases a device granted after an abort, and ends once', async () => {
		const grant = slowPrompt();
		const onEnd = vi.fn();
		const { dictateNatively } = await loadNative();

		const session = dictateNatively({ onTranscript: vi.fn(), onEnd });
		session?.abort();
		await settle();
		grant();
		await settle();

		expect(onEnd).toHaveBeenCalledTimes(1);
		expect(stream.tracks[0].stopped).toBe(true);
		expect(FakeAudioContext.built[0]?.closed ?? true).toBe(true);
	});
});

describe('the three commands', () => {
	it('reads the status straight off the host', async () => {
		const status = {
			model: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17',
			installed: true,
			bytes: 240_506_435,
			downloadBytes: 163_002_883,
			loaded: false,
			languages: ['zh', 'en', 'ja', 'ko', 'yue']
		};
		invoke.mockResolvedValue(status);
		const { nativeAsrStatus } = await loadNative();

		await expect(nativeAsrStatus()).resolves.toEqual(status);
		expect(invoke).toHaveBeenCalledWith('asr_status');
	});

	it('subscribes to progress before it starts the download', async () => {
		const order: string[] = [];
		listen.mockImplementation(async () => {
			order.push('listen');
			return () => {};
		});
		invoke.mockImplementation(async (command) => {
			order.push(command);
			return undefined;
		});
		const { installAsrModel } = await loadNative();

		await installAsrModel();

		// The other way round loses the first ticks, and the bar jumps in from
		// the middle of a download it never saw start.
		expect(order).toEqual(['listen', 'asr_download']);
	});
});
