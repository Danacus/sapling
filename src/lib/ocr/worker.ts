/**
 * The OCR worker: fetches and caches the models, holds the ONNX sessions and
 * runs the whole page — preprocessing, both models, decoding — off the window
 * thread. One page at a time; the window queues.
 */
import * as ort from 'onnxruntime-web/webgpu';

import type { ModelSet } from './models';
import { detBoxes, detInput, recDecode, recInput, type OcrLine, type Raster } from './pipeline';
import type { OcrBackend, OcrRequest, OcrResponse } from './protocol';

// From the CDN, at exactly the installed version (`vite.config.ts` says why).
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
// Threads need cross-origin isolation, which the app does not have (`static/_headers`).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1;

const CACHE = 'sapling-ocr-models-v1';

function post(message: OcrResponse, transfer: Transferable[] = []) {
	(self as unknown as Worker).postMessage(message, transfer);
}

async function fetchCached(url: string, id: number, label: string): Promise<ArrayBuffer> {
	const cache = await caches.open(CACHE).catch(() => undefined);
	const hit = await cache?.match(url);
	if (hit) return hit.arrayBuffer();
	const response = await fetch(url);
	if (!response.ok || !response.body) throw new Error(`${label}: HTTP ${response.status}`);
	const total = Number(response.headers.get('content-length') ?? 0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.length;
		post({ id, kind: 'progress', stage: `Downloading ${label}`, done: loaded, total });
	}
	const bytes = new Uint8Array(loaded);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	await cache?.put(url, new Response(bytes)).catch(() => undefined);
	return bytes.buffer;
}

interface Loaded {
	key: string;
	det: ort.InferenceSession;
	rec: ort.InferenceSession;
	dict: string[];
	backend: string;
}

let loaded: Loaded | undefined;

async function load(set: ModelSet, backend: OcrBackend, id: number): Promise<Loaded> {
	const key = `${set.id}:${backend}`;
	if (loaded?.key === key) return loaded;
	await loaded?.det.release();
	await loaded?.rec.release();
	loaded = undefined;
	const [det, rec, dict] = await Promise.all([
		fetchCached(set.det, id, 'detector'),
		fetchCached(set.rec, id, 'recognizer'),
		fetchCached(set.dict, id, 'dictionary')
	]);
	post({ id, kind: 'progress', stage: 'Starting the models', done: 0, total: 0 });
	const gpu = backend !== 'wasm' && 'gpu' in navigator;
	const options: ort.InferenceSession.SessionOptions = {
		executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm']
	};
	const lines = new TextDecoder().decode(dict).split(/\r?\n/);
	if (lines.at(-1) === '') lines.pop();
	loaded = {
		key,
		det: await ort.InferenceSession.create(new Uint8Array(det), options),
		rec: await ort.InferenceSession.create(new Uint8Array(rec), options),
		dict: lines,
		backend: gpu ? 'webgpu' : 'wasm'
	};
	return loaded;
}

function tensorOf(value: ort.Tensor) {
	return { data: value.data as Float32Array, dims: value.dims as number[] };
}

async function recognize(raster: Raster, models: Loaded, id: number): Promise<OcrLine[]> {
	const input = detInput(raster);
	const detOut = await models.det.run({
		[models.det.inputNames[0]]: new ort.Tensor('float32', input.data, input.dims)
	});
	const boxes = detBoxes(tensorOf(detOut[models.det.outputNames[0]]), input, raster);
	const lines: OcrLine[] = [];
	for (const [i, box] of boxes.entries()) {
		post({ id, kind: 'progress', stage: 'Reading lines', done: i, total: boxes.length });
		const rec = recInput(raster, box);
		const out = await models.rec.run({
			[models.rec.inputNames[0]]: new ort.Tensor('float32', rec.data, rec.dims)
		});
		const line = recDecode(tensorOf(out[models.rec.outputNames[0]]), rec, box, models.dict);
		if (line.text.trim()) lines.push(line);
	}
	return lines;
}

/**
 * One job at a time (sessions must not be created concurrently), and only the
 * newest: the viewer shows one page, so a request a later one overtook while
 * it waited is answered `superseded` without running.
 */
let queue: Promise<void> = Promise.resolve();
let latest = 0;

self.onmessage = (event: MessageEvent<OcrRequest>) => {
	latest = event.data.id;
	queue = queue.then(() => run(event.data));
};

async function run({ id, raster, set, backend }: OcrRequest) {
	if (id !== latest) {
		post({ id, kind: 'error', message: 'superseded' });
		return;
	}
	try {
		const started = performance.now();
		const models = await load(set, backend, id);
		const loadMs = performance.now() - started;
		const t = performance.now();
		const lines = await recognize(raster, models, id);
		post({
			id,
			kind: 'done',
			lines,
			timings: { loadMs, pageMs: performance.now() - t },
			backend: models.backend
		});
	} catch (cause) {
		post({ id, kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
	}
}
