/**
 * Vitest setup: the wasm core, instantiated before any test file runs — what
 * the root layout's `loadWindowCore` is in the browser.
 */

import { loadWasmCore } from './backend.testing';

loadWasmCore();
