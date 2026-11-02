/** The messages between the window and the OCR worker. */
import type { ModelSet } from './models';
import type { OcrLine, Raster } from './pipeline';

/** `auto` tries WebGPU and falls back to wasm per operator; `wasm` forces the CPU. */
export type OcrBackend = 'auto' | 'wasm';

export interface OcrRequest {
	id: number;
	raster: Raster;
	set: ModelSet;
	backend: OcrBackend;
}

export interface OcrTimings {
	/** Downloading (first time) and creating the sessions; ~0 once warm. */
	loadMs: number;
	/** Detection and recognition of the page. */
	pageMs: number;
}

export type OcrResponse =
	| { id: number; kind: 'progress'; stage: string; done: number; total: number }
	| { id: number; kind: 'done'; lines: OcrLine[]; timings: OcrTimings; backend: string }
	| { id: number; kind: 'error'; message: string };
