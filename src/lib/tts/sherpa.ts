/**
 * Main-thread side of the neural voice: owns the worker, the progress
 * fan-out, and the request/response plumbing. Everything heavy lives in
 * `sherpa.worker.ts`; this file is deliberately boring.
 *
 * The worker is created lazily on the first `initSherpa()`/`synthesize()`, so
 * a learner who never taps 🔊 (or who picked the browser voice) never spawns a
 * thread, never downloads a byte, and never pays for any of this.
 *
 * Nothing here is allowed to be fatal. Every rejection is caught one layer up
 * in `tts.ts` and turned into a Web Speech fallback plus a `console.warn` —
 * see the module note there.
 */

import type { SherpaRequest, SherpaResponse } from './sherpa.worker';
import { encodeWav } from './wav';

/**
 * One file's download progress. Kept structurally identical to what the old
 * Transformers.js backend emitted so the Settings progress bar is unchanged.
 */
export interface TtsProgress {
	/** File being fetched, e.g. `sherpa-onnx-wasm-main-tts.data`. */
	file: string;
	/** 0-100. */
	progress: number;
	loaded: number;
	total: number;
}

const progressListeners = new Set<(progress: TtsProgress) => void>();

/**
 * Subscribe to download progress. Returns an unsubscribe function. Progress
 * only flows while a download is actually in flight; a warm engine reports
 * nothing, which is why the Settings button also handles "finished instantly".
 */
export function onSherpaProgress(listener: (progress: TtsProgress) => void): () => void {
	progressListeners.add(listener);
	return () => progressListeners.delete(listener);
}

function emitProgress(file: string, loaded: number, total: number): void {
	const progress: TtsProgress = {
		file,
		loaded,
		total,
		progress: total > 0 ? Math.min(100, (loaded / total) * 100) : 0
	};
	for (const listener of progressListeners) listener(progress);
}

// -- Worker plumbing --------------------------------------------------------

interface Pending {
	resolve: (audio: { samples: Float32Array; sampleRate: number }) => void;
	reject: (cause: Error) => void;
}

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let readyResolve: (() => void) | null = null;
let readyReject: ((cause: Error) => void) | null = null;

const pending = new Map<number, Pending>();
let nextRequestId = 1;

/** Wipes the worker so the next call starts from scratch. */
function teardown(cause: Error): void {
	for (const request of pending.values()) request.reject(cause);
	pending.clear();
	readyReject?.(cause);
	readyResolve = null;
	readyReject = null;
	ready = null;
	try {
		worker?.terminate();
	} catch {
		/* ignore */
	}
	worker = null;
}

function handle(message: SherpaResponse): void {
	switch (message.type) {
		case 'progress':
			emitProgress(message.file, message.loaded, message.total);
			return;
		case 'ready':
			console.info(
				`[tts] Kokoro ready: ${message.numSpeakers} speakers at ${message.sampleRate} Hz.`
			);
			readyResolve?.();
			readyResolve = null;
			readyReject = null;
			return;
		case 'audio': {
			const request = pending.get(message.id);
			pending.delete(message.id);
			request?.resolve({ samples: message.samples, sampleRate: message.sampleRate });
			return;
		}
		case 'failed': {
			const error = new Error(message.message);
			if (message.id === undefined) {
				// A start-up failure: nothing loaded, so drop the worker entirely
				// and let a later attempt rebuild it (the files are cached by then).
				teardown(error);
				return;
			}
			const request = pending.get(message.id);
			pending.delete(message.id);
			request?.reject(error);
			return;
		}
	}
}

/**
 * Boots the worker and waits for the model to be live. Repeated calls share
 * one boot; a failed boot is forgotten so the next call can retry.
 */
export function initSherpa(): Promise<void> {
	if (ready) return ready;

	if (typeof Worker === 'undefined') {
		return Promise.reject(new Error('This browser cannot run Web Workers.'));
	}

	ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;

		try {
			worker = new Worker(new URL('./sherpa.worker.ts', import.meta.url));
		} catch (cause) {
			reject(cause instanceof Error ? cause : new Error(String(cause)));
			ready = null;
			return;
		}

		worker.onmessage = (event: MessageEvent) => handle(event.data as SherpaResponse);
		worker.onerror = (event) => teardown(new Error(event.message || 'the speech worker crashed'));
		post({ type: 'init' });
	});

	// Do not remember a failure forever: a dropped connection should not
	// permanently disable speech.
	ready.catch(() => {
		ready = null;
	});

	return ready;
}

function post(request: SherpaRequest): void {
	worker?.postMessage(request);
}

/**
 * Synthesizes one phrase to a WAV blob.
 *
 * `speakerId` is an index into the model's 103 voices and `speed` is a
 * multiplier (1 = as trained). Rejects if the engine cannot load or the model
 * returns nothing.
 */
export async function synthesize(text: string, speakerId: number, speed = 1): Promise<Blob> {
	await initSherpa();

	const id = nextRequestId++;
	const audio = await new Promise<{ samples: Float32Array; sampleRate: number }>(
		(resolve, reject) => {
			pending.set(id, { resolve, reject });
			post({ type: 'generate', id, text, speakerId, speed });
		}
	);

	return new Blob([encodeWav(audio.samples, audio.sampleRate)], { type: 'audio/wav' });
}
