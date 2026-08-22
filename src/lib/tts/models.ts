/**
 * Where the sherpa-onnx runtime and the Kokoro model come from, and what they
 * should weigh. Pure data plus a couple of helpers, so the URL/size/cache-name
 * logic can be unit-tested in node without touching the network.
 *
 * ## The two halves of the engine
 *
 * The engine is one Emscripten build of sherpa-onnx's offline-TTS C API, split
 * across four files:
 *
 * | file | where it lives | why |
 * | --- | --- | --- |
 * | `sherpa-worker.js` | vendored in `static/tts/` | 9 KB classic worker that drives it all |
 * | `sherpa-onnx-tts.js` | vendored in `static/tts/` | 26 KB hand-written C-API wrapper |
 * | `sherpa-onnx-wasm-main-tts.js` | vendored in `static/tts/` | 121 KB Emscripten glue |
 * | `sherpa-onnx-wasm-main-tts.wasm` | fetched at runtime | 11.9 MB |
 * | `sherpa-onnx-wasm-main-tts.data` | fetched at runtime | 426.7 MB — the whole model |
 *
 * The two JS files are small enough to live in git, which also pins the exact
 * loader code; the two big binaries are fetched on first use and kept in Cache
 * Storage. **All four must come from the same build** — the `.data` file is an
 * Emscripten file-package whose byte offsets are baked into the glue — hence
 * the pinned revision below.
 *
 * ## Why this bundle, and why fp32
 *
 * sherpa-onnx publishes no npm package with a browser WASM build, and its own
 * GitHub releases only ship WASM TTS bundles for the English `pocket`/`piper`
 * models. Kokoro multi-lang exists only as third-party prebuilt packs on the
 * Hugging Face Hub, so that is what we fetch, pinned to one immutable commit.
 *
 * **The int8 pack is unusable**, and this is not a guess: every published
 * int8 Kokoro WASM build produces all-`NaN` samples from ONNX inference — a
 * known upstream bug, <https://github.com/k2-fsa/sherpa-onnx/issues/2236>,
 * which building from source does not fix. It was reproduced here in Firefox
 * against the int8 pack (silent output, nondeterministically from the first or
 * second phrase onwards) and *not* reproduced against this fp32 pack, which
 * returned clean audio for Mandarin, mixed zh/en and English across several
 * speakers. So we pay 439 MB instead of 227 MB and get sound.
 *
 * The `.data` payload matches the official `csukuangfj/kokoro-multi-lang-v1_1`
 * model files: `model.onnx` 325,631,784 B (the fp32 export) and `voices.bin`
 * 53,790,720 B = 103 speakers x 510 x 256 x float32.
 */

/** Cache Storage bucket holding the two big runtime downloads. */
export const MODEL_CACHE_NAME = 'll-tts-models';

/** The Hugging Face dataset holding the prebuilt WASM packs. */
const BUNDLE_REPO = 'datasets/jiangzhuo9357/sherpa-onnx-tts-models';

/** The pack inside that dataset: Kokoro v1.1 multi-lang, fp32 weights. */
const BUNDLE_DIR = 'wasm-kokoro-fp32';

/**
 * Pinned commit of that dataset. Never track `main`: a rebuild there would
 * change the file-package layout and desynchronize it from the glue we vendor.
 */
export const BUNDLE_REVISION = 'c1285229a3298e283467dca880086b3ac59fb50d';

/** Human-facing name of the model inside the bundle. */
export const KOKORO_MODEL_ID = 'kokoro-multi-lang-v1_1 (fp32)';

/** One runtime file we have to download before the engine can start. */
export interface RuntimeArtifact {
	/** File name, also the progress-reporting key. */
	readonly file: string;
	/** Exact expected size. A mismatch means a truncated or wrong build. */
	readonly bytes: number;
}

/**
 * The two big files, in load order. Sizes are exact and are checked after
 * download — a partial response that somehow reached Cache Storage would
 * otherwise poison every later start-up.
 */
export const RUNTIME_ARTIFACTS: readonly RuntimeArtifact[] = [
	{ file: 'sherpa-onnx-wasm-main-tts.wasm', bytes: 11903250 },
	{ file: 'sherpa-onnx-wasm-main-tts.data', bytes: 426654376 }
];

/** Total first-run download, in bytes. */
export const RUNTIME_DOWNLOAD_BYTES = RUNTIME_ARTIFACTS.reduce(
	(total, artifact) => total + artifact.bytes,
	0
);

/**
 * The vendored JS the worker `importScripts`, in load order — the C-API wrapper
 * first, because it must define `createOfflineTts` before the glue finishes
 * instantiating and calls `onRuntimeInitialized`.
 */
export const RUNTIME_SCRIPT_FILES: readonly string[] = [
	'sherpa-onnx-tts.js',
	'sherpa-onnx-wasm-main-tts.js'
];

/**
 * The worker itself. It lives in `static/` rather than `src/` because it must
 * be a *classic* worker (`importScripts` does not exist in module workers), and
 * a classic worker built from a TS module is bundled to an IIFE by `pnpm build`
 * but served as ESM by `vite dev` — which threw `Cannot use import statement
 * outside a module` in dev only. Served verbatim, the two modes cannot diverge.
 */
export const WORKER_SCRIPT_FILE = 'sherpa-worker.js';

/**
 * URL of one file in `static/tts/`.
 *
 * `base` is SvelteKit's configured base path (`''` unless the app is deployed
 * under a sub-path); it is threaded through rather than assumed so a future
 * `paths.base` cannot silently break the worker.
 */
export function ttsAssetUrl(file: string, base = ''): string {
	return `${base}/tts/${file}`;
}

/** Download URL for one artifact, pinned to {@link BUNDLE_REVISION}. */
export function artifactUrl(file: string, revision: string = BUNDLE_REVISION): string {
	return `https://huggingface.co/${BUNDLE_REPO}/resolve/${revision}/${BUNDLE_DIR}/${file}`;
}

/**
 * Rounded-up size for UI copy. Deliberately decimal MB (what a browser's
 * download UI shows) rather than MiB.
 */
export function formatMb(bytes: number): string {
	return `${Math.round(bytes / 1e6)} MB`;
}
