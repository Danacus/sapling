/**
 * OCR for a page image, in a worker (spike). `ocrPage` hands a raster to the
 * worker, which downloads the models on first use (Cache API, kept across
 * visits) and answers lines of text with every character's x on the page.
 *
 * On a Tauri host it is a native call instead (`native.ts`): the same pipeline
 * in Rust over ONNX Runtime with all cores, behind the same `ocrPage`.
 */
import { inTauri } from '$lib/platform';

import type { ModelSet } from './models';
import type { OcrLine, Raster } from './pipeline';
import type { OcrBackend, OcrRequest, OcrResponse, OcrTimings } from './protocol';

export {
	modelSet,
	scriptFor,
	sizesFor,
	type ModelSet,
	type OcrScript,
	type OcrSize
} from './models';
export type { Box, OcrLine, Raster } from './pipeline';
export type { OcrBackend, OcrTimings } from './protocol';

export interface OcrProgress {
	stage: string;
	done: number;
	total: number;
}

export interface OcrResult {
	lines: OcrLine[];
	timings: OcrTimings;
	backend: string;
}

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<
	number,
	{
		resolve: (result: OcrResult) => void;
		reject: (error: Error) => void;
		onProgress?: (progress: OcrProgress) => void;
	}
>();

function workerOf(): Worker {
	if (worker) return worker;
	worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
	worker.onmessage = (event: MessageEvent<OcrResponse>) => {
		const message = event.data;
		const waiting = pending.get(message.id);
		if (!waiting) return;
		if (message.kind === 'progress') {
			waiting.onProgress?.(message);
			return;
		}
		pending.delete(message.id);
		if (message.kind === 'done') waiting.resolve(message);
		else waiting.reject(new Error(message.message));
	};
	return worker;
}

export function ocrPage(
	raster: Raster,
	set: ModelSet,
	backend: OcrBackend,
	onProgress?: (progress: OcrProgress) => void
): Promise<OcrResult> {
	if (inTauri()) {
		return import('./native').then(({ ocrPageNatively }) =>
			ocrPageNatively(raster, set, onProgress)
		);
	}
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, onProgress });
		const request: OcrRequest = { id, raster, set, backend };
		workerOf().postMessage(request);
	});
}
