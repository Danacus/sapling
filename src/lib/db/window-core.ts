/**
 * The wasm build on the window thread, where the model calls and the challenge
 * decisions run (the database Worker loads the same bytes for itself). The
 * root layout awaits {@link loadWindowCore} before the first page renders, so
 * the synchronous challenge calls can assume it; node tests `initSync` the
 * same file instead (`vitest.setup.ts`).
 */

import init from './wasm/sapling_core';
import wasmUrl from './wasm/sapling_core_bg.wasm?url';

let ready: Promise<unknown> | undefined;

export function loadWindowCore(): Promise<unknown> {
	ready ??= init({ module_or_path: wasmUrl });
	return ready;
}
