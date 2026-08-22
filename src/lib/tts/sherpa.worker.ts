/**
 * The speech engine itself, off the main thread.
 *
 * Everything expensive happens here: a ~227 MB download, an Emscripten module
 * with a 215 MB in-memory filesystem, and one ONNX inference per phrase that
 * takes a second or two on a CPU. None of that may touch the UI thread, or a
 * learner tapping 🔊 mid-lesson would watch the page freeze.
 *
 * ## How the runtime is assembled
 *
 * `sherpa-onnx-wasm-main-tts.js` is stock Emscripten glue: left alone it would
 * `fetch()` its own `.wasm` and XHR its own `.data` package with no progress we
 * could show and no cache we could control. It does, however, honour two
 * documented escape hatches — `Module.wasmBinary` and
 * `Module.getPreloadedPackage()` — so we download both files ourselves (with
 * byte-accurate progress and Cache Storage), hand them over, and only then
 * `importScripts()` the glue, which finds everything already in memory.
 *
 * The vendored files are loaded from our own origin; only the two binaries are
 * cross-origin, and they are fetched with plain `fetch` (no credentials).
 *
 * ## What this build is
 *
 * Single-threaded WASM+SIMD: the bundle contains no pthread worker and never
 * touches `SharedArrayBuffer`, so it needs **no COOP/COEP headers** and runs on
 * any dumb static host. There is no GPU path — sherpa-onnx's WASM build is
 * CPU-only.
 */

import { artifactUrl, MODEL_CACHE_NAME, RUNTIME_ARTIFACTS, RUNTIME_SCRIPTS } from './models';

// -- Messages ---------------------------------------------------------------

/** Main thread → worker. */
export type SherpaRequest =
	| { type: 'init' }
	| { type: 'generate'; id: number; text: string; speakerId: number; speed: number };

/** Worker → main thread. */
export type SherpaResponse =
	| { type: 'progress'; file: string; loaded: number; total: number }
	| { type: 'ready'; sampleRate: number; numSpeakers: number }
	| { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
	| { type: 'failed'; id?: number; message: string };

// -- Ambient shapes ---------------------------------------------------------
//
// Typed by hand rather than via `lib.webworker`: pulling that lib in next to
// the DOM lib collides on dozens of globals, and we only need four things.

interface EmscriptenModule {
	wasmBinary?: ArrayBuffer;
	getPreloadedPackage?: (name: string, size: number) => ArrayBuffer | null;
	locateFile?: (path: string) => string;
	onRuntimeInitialized?: () => void;
	onAbort?: (reason: unknown) => void;
	print?: (text: string) => void;
	printErr?: (text: string) => void;
}

/** The handle `createOfflineTts` returns; see `static/tts/sherpa-onnx-tts.js`. */
interface OfflineTts {
	sampleRate: number;
	numSpeakers: number;
	generate(config: { text: string; sid: number; speed: number }): {
		samples: Float32Array;
		sampleRate: number;
	};
}

interface WorkerScope {
	importScripts: (...urls: string[]) => void;
	postMessage: (message: SherpaResponse, transfer?: Transferable[]) => void;
	addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
	Module?: EmscriptenModule;
	createOfflineTts?: (module: EmscriptenModule, config: unknown) => OfflineTts;
}

const scope = globalThis as unknown as WorkerScope;

// -- Download + cache -------------------------------------------------------

/**
 * Cache Storage needs a secure context; on plain http (or with site data
 * blocked) we still work, just re-downloading every time.
 */
async function openCache(): Promise<Cache | null> {
	try {
		if (typeof caches === 'undefined') return null;
		return await caches.open(MODEL_CACHE_NAME);
	} catch {
		return null;
	}
}

/**
 * Reads a response body into a pre-sized buffer, reporting bytes as they land.
 *
 * Pre-sizing (rather than concatenating chunks at the end) matters at this
 * scale: the naive version would momentarily hold two 215 MB copies.
 */
async function drain(
	body: ReadableStream<Uint8Array>,
	expected: number,
	onProgress: (loaded: number) => void
): Promise<ArrayBuffer> {
	const bytes = new Uint8Array(expected);
	const reader = body.getReader();
	let loaded = 0;

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (loaded + value.length > expected) {
			throw new Error(`response is larger than the expected ${expected} bytes`);
		}
		bytes.set(value, loaded);
		loaded += value.length;
		onProgress(loaded);
	}

	if (loaded !== expected) {
		throw new Error(`expected ${expected} bytes, got ${loaded}`);
	}
	return bytes.buffer as ArrayBuffer;
}

/**
 * Fetches one artifact, preferring the cached copy.
 *
 * A cache hit whose size is wrong is deleted rather than trusted: the whole
 * engine is a byte-offset table into these files, so a truncated `.data` would
 * fail in a much more confusing way later.
 */
async function loadArtifact(
	file: string,
	expected: number,
	onProgress: (loaded: number) => void
): Promise<ArrayBuffer> {
	const url = artifactUrl(file);
	const cache = await openCache();

	if (cache) {
		try {
			const hit = await cache.match(url);
			if (hit) {
				const cached = await hit.arrayBuffer();
				if (cached.byteLength === expected) {
					onProgress(expected);
					return cached;
				}
				console.warn(`[tts] Cached ${file} was ${cached.byteLength} B, expected ${expected} B.`);
				await cache.delete(url);
			}
		} catch (cause) {
			console.warn(`[tts] Could not read ${file} from the cache.`, cause);
		}
	}

	const response = await fetch(url);
	if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
	if (!response.body) {
		const whole = await response.arrayBuffer();
		if (whole.byteLength !== expected) {
			throw new Error(`${file}: expected ${expected} bytes, got ${whole.byteLength}`);
		}
		onProgress(expected);
		return whole;
	}

	// Tee so the cache write streams straight to disk instead of us holding a
	// second full copy in JS memory.
	let toRead: ReadableStream<Uint8Array> = response.body;
	let cacheWrite: Promise<void> = Promise.resolve();
	if (cache) {
		const [forUs, forCache] = response.body.tee();
		toRead = forUs;
		cacheWrite = cache
			.put(url, new Response(forCache, { headers: { 'content-type': 'application/octet-stream' } }))
			.catch((cause) => console.warn(`[tts] Could not cache ${file}.`, cause));
	}

	const buffer = await drain(toRead, expected, onProgress);
	await cacheWrite;
	return buffer;
}

// -- Engine -----------------------------------------------------------------

/**
 * The model config. Mirrors k2-fsa's own `kokoro-tts-zh-en` example: two
 * lexicons (English + Chinese) and espeak-ng data for everything the lexicons
 * miss, plus the date/number FSTs that turn "2026" into 二零二六 rather than a
 * spelled-out mess. Paths are inside the Emscripten filesystem, which the
 * `.data` package populates.
 *
 * `dictDir` is intentionally absent: since sherpa-onnx v1.12.15 Kokoro word
 * segmentation uses a phrase matcher over the lexicon, and passing a dict dir
 * only logs a "not used" warning.
 */
const TTS_CONFIG = {
	offlineTtsModelConfig: {
		offlineTtsKokoroModelConfig: {
			model: './model.onnx',
			voices: './voices.bin',
			tokens: './tokens.txt',
			dataDir: './espeak-ng-data',
			lexicon: './lexicon-us-en.txt,./lexicon-zh.txt',
			lang: '',
			lengthScale: 1.0
		},
		numThreads: 1,
		debug: 0,
		provider: 'cpu'
	},
	ruleFsts: './date-zh.fst,./number-zh.fst',
	ruleFars: '',
	maxNumSentences: 1,
	silenceScale: 0.2
};

let tts: OfflineTts | null = null;
let starting: Promise<OfflineTts> | null = null;

function reportProgress(file: string, loaded: number, total: number): void {
	scope.postMessage({ type: 'progress', file, loaded, total });
}

async function start(): Promise<OfflineTts> {
	const [wasmArtifact, dataArtifact] = RUNTIME_ARTIFACTS;

	// Announce both files up front so the progress bar spans the whole
	// download from the first tick instead of jumping when the second starts.
	reportProgress(wasmArtifact.file, 0, wasmArtifact.bytes);
	reportProgress(dataArtifact.file, 0, dataArtifact.bytes);

	const wasmBinary = await loadArtifact(wasmArtifact.file, wasmArtifact.bytes, (loaded) =>
		reportProgress(wasmArtifact.file, loaded, wasmArtifact.bytes)
	);
	const dataPackage = await loadArtifact(dataArtifact.file, dataArtifact.bytes, (loaded) =>
		reportProgress(dataArtifact.file, loaded, dataArtifact.bytes)
	);

	return await new Promise<OfflineTts>((resolve, reject) => {
		const module: EmscriptenModule = {
			wasmBinary,
			// Both hooks are the documented way to say "already downloaded".
			getPreloadedPackage: () => dataPackage,
			locateFile: (path) => path,
			printErr: (text) => console.warn('[sherpa-onnx]', text),
			onAbort: (reason) => reject(new Error(`sherpa-onnx aborted: ${String(reason)}`)),
			onRuntimeInitialized: () => {
				try {
					const create = scope.createOfflineTts;
					if (!create) throw new Error('sherpa-onnx-tts.js did not define createOfflineTts');
					const engine = create(module, TTS_CONFIG);
					if (!engine.numSpeakers) throw new Error('the model reported zero speakers');
					resolve(engine);
				} catch (cause) {
					reject(cause instanceof Error ? cause : new Error(String(cause)));
				}
			}
		};

		scope.Module = module;
		try {
			// Wrapper first: it must define `createOfflineTts` before the glue
			// finishes instantiating and calls `onRuntimeInitialized`.
			scope.importScripts(...RUNTIME_SCRIPTS);
		} catch (cause) {
			reject(cause instanceof Error ? cause : new Error(String(cause)));
		}
	});
}

function ensureStarted(): Promise<OfflineTts> {
	if (tts) return Promise.resolve(tts);
	if (starting) return starting;

	const attempt = start();
	starting = attempt;
	attempt.then(
		(engine) => {
			tts = engine;
		},
		() => {
			// A failed start must not be remembered: the download may simply have
			// been interrupted, and the next tap deserves a fresh try. The
			// Emscripten module is not reusable, but `importScripts` of the same
			// URL is a no-op, so a retry re-runs against the cached files.
			if (starting === attempt) starting = null;
		}
	);
	return attempt;
}

// -- Message loop -----------------------------------------------------------

scope.addEventListener('message', (event: MessageEvent) => {
	const request = event.data as SherpaRequest;

	if (request.type === 'init') {
		ensureStarted().then(
			(engine) =>
				scope.postMessage({
					type: 'ready',
					sampleRate: engine.sampleRate,
					numSpeakers: engine.numSpeakers
				}),
			(cause: unknown) =>
				scope.postMessage({ type: 'failed', message: describe(cause) })
		);
		return;
	}

	if (request.type === 'generate') {
		const { id, text, speakerId, speed } = request;
		ensureStarted()
			.then((engine) => engine.generate({ text, sid: speakerId, speed }))
			.then(
				(audio) => {
					if (!audio.samples.length) throw new Error('the model produced no samples');
					if (!isAudible(audio.samples)) {
						// Hard-won check: the int8 build of this very model returns an
						// array of NaN from ONNX inference (sherpa-onnx#2236), which the
						// WAV encoder would happily turn into a perfectly silent clip.
						// Failing loudly here means the caller falls back to the browser
						// voice instead of the learner hearing nothing at all.
						throw new Error('the model produced silence (all-zero or NaN samples)');
					}
					scope.postMessage(
						{ type: 'audio', id, samples: audio.samples, sampleRate: audio.sampleRate },
						[audio.samples.buffer]
					);
				},
				(cause: unknown) => scope.postMessage({ type: 'failed', id, message: describe(cause) })
			);
	}
});

/**
 * Whether a clip contains any actual signal. Cheap (one pass, early exit) and
 * NaN-safe: `Math.abs(NaN) > threshold` is false, so an all-NaN buffer fails.
 */
function isAudible(samples: Float32Array): boolean {
	for (let i = 0; i < samples.length; i++) {
		if (Math.abs(samples[i]) > 1e-4) return true;
	}
	return false;
}

function describe(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	return String(cause);
}
