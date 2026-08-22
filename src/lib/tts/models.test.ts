import { describe, expect, it } from 'vitest';

import {
	artifactUrl,
	BUNDLE_REVISION,
	formatMb,
	KOKORO_MODEL_ID,
	MODEL_CACHE_NAME,
	RUNTIME_ARTIFACTS,
	RUNTIME_DOWNLOAD_BYTES,
	RUNTIME_SCRIPT_FILES,
	ttsAssetUrl,
	WORKER_SCRIPT_FILE
} from './models';

describe('runtime artifacts', () => {
	it('names the two files the Emscripten bundle needs, with exact sizes', () => {
		expect(RUNTIME_ARTIFACTS.map((artifact) => artifact.file)).toEqual([
			'sherpa-onnx-wasm-main-tts.wasm',
			'sherpa-onnx-wasm-main-tts.data'
		]);
		// Checked against the pinned revision with HTTP HEAD. These are compared
		// against the real download, so a wrong number here breaks the engine
		// loudly instead of producing a truncated model.
		expect(RUNTIME_ARTIFACTS[0].bytes).toBe(11903250);
		expect(RUNTIME_ARTIFACTS[1].bytes).toBe(426654376);
		expect(RUNTIME_DOWNLOAD_BYTES).toBe(11903250 + 426654376);
	});

	it('pins an immutable revision rather than a branch', () => {
		// A moving `main` would eventually serve a .data whose byte offsets no
		// longer match the glue vendored in static/tts/.
		expect(BUNDLE_REVISION).toMatch(/^[0-9a-f]{40}$/);
		expect(artifactUrl('sherpa-onnx-wasm-main-tts.data')).toBe(
			'https://huggingface.co/datasets/jiangzhuo9357/sherpa-onnx-tts-models/resolve/' +
				`${BUNDLE_REVISION}/wasm-kokoro-fp32/sherpa-onnx-wasm-main-tts.data`
		);
	});

	it('loads the vendored glue wrapper-first', () => {
		// The wrapper defines createOfflineTts, which the glue's
		// onRuntimeInitialized callback needs the moment it fires.
		expect(RUNTIME_SCRIPT_FILES).toEqual([
			'sherpa-onnx-tts.js',
			'sherpa-onnx-wasm-main-tts.js'
		]);
	});

	it('serves the worker verbatim from static/, not through Vite', () => {
		// A Vite-bundled classic worker is an IIFE in `pnpm build` but ESM in
		// `vite dev`, which breaks dev only. This file is copied as-is.
		expect(WORKER_SCRIPT_FILE).toBe('sherpa-worker.js');
	});

	it('uses a dedicated cache bucket so clearing it cannot touch app data', () => {
		expect(MODEL_CACHE_NAME).toBe('ll-tts-models');
	});

	it('identifies the fp32 multi-lang model', () => {
		// fp32 on purpose: the int8 export returns all-NaN samples under the WASM
		// ONNX runtime (sherpa-onnx#2236), which is silence, not speech.
		expect(KOKORO_MODEL_ID).toContain('kokoro-multi-lang-v1_1');
		expect(KOKORO_MODEL_ID).toContain('fp32');
	});
});

describe('ttsAssetUrl', () => {
	it('points at static/tts on the app\'s own origin', () => {
		expect(ttsAssetUrl('sherpa-worker.js')).toBe('/tts/sherpa-worker.js');
		expect(ttsAssetUrl(RUNTIME_SCRIPT_FILES[0])).toBe('/tts/sherpa-onnx-tts.js');
	});

	it('respects a SvelteKit base path', () => {
		// `base` is '' today, but a sub-path deploy must not silently 404 the
		// worker and leave speech dead.
		expect(ttsAssetUrl('sherpa-worker.js', '/learn')).toBe('/learn/tts/sherpa-worker.js');
	});
});

describe('formatMb', () => {
	it('rounds to whole decimal megabytes for UI copy', () => {
		expect(formatMb(RUNTIME_DOWNLOAD_BYTES)).toBe('439 MB');
		expect(formatMb(11903250)).toBe('12 MB');
		expect(formatMb(0)).toBe('0 MB');
	});
});
