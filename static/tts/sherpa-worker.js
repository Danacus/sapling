/**
 * The speech engine itself, off the main thread.
 *
 * Everything expensive happens here: a ~439 MB download, an Emscripten module
 * with a 427 MB in-memory filesystem, and one ONNX inference per phrase that
 * takes a second or two on a CPU. None of that may touch the UI thread, or a
 * learner tapping the speaker button mid-lesson would watch the page freeze.
 *
 * ## Why this file is plain JS in `static/`, not TypeScript in `src/`
 *
 * It has to be a **classic** worker, because `importScripts()` is the only way
 * to load the Emscripten glue (a classic script that installs a global
 * `Module`), and `importScripts` does not exist in module workers. A classic
 * worker may therefore contain no `import`/`export` at all.
 *
 * Written as a TS module under `src/` it would be bundled to a self-contained
 * IIFE for `pnpm build` but served as ESM by `vite dev` — so it worked in the
 * production build and threw `Cannot use import statement outside a module` in
 * dev. Keeping it here, served verbatim in both modes, removes that whole class
 * of divergence. The cost is that it is untyped; the message protocol it must
 * honour is typed on the other side, in `src/lib/tts/sherpa.ts`.
 *
 * Everything environment-specific (artifact URLs, expected sizes, cache name,
 * the scripts to `importScripts`) arrives in the `init` message, so
 * `src/lib/tts/models.ts` stays the single source of truth.
 *
 * ## How the runtime is assembled
 *
 * `sherpa-onnx-wasm-main-tts.js` is stock Emscripten glue: left alone it would
 * `fetch()` its own `.wasm` and XHR its own `.data` package, with no progress
 * we could show and no cache we could control. It does, however, honour two
 * documented escape hatches — `Module.wasmBinary` and
 * `Module.getPreloadedPackage()` — so we download both files ourselves (with
 * byte-accurate progress and Cache Storage), hand them over, and only then
 * `importScripts()` the glue, which finds everything already in memory.
 *
 * ## What this build is
 *
 * Single-threaded WASM+SIMD: the bundle contains no pthread worker and never
 * touches `SharedArrayBuffer`, so it needs no COOP/COEP headers and runs on any
 * dumb static host. There is no GPU path — sherpa-onnx's WASM build is
 * CPU-only.
 *
 * @typedef {{ file: string, url: string, bytes: number }} Artifact
 * @typedef {{ artifacts: Artifact[], scripts: string[], cacheName: string }} InitConfig
 */

'use strict';

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
var TTS_CONFIG = {
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

/** @type {InitConfig | null} */
var config = null;
/** The live engine, once started. */
var tts = null;
/** The in-flight start, so concurrent requests share one boot. */
var starting = null;

// -- Download + cache -------------------------------------------------------

/**
 * Cache Storage needs a secure context; on plain http (or with site data
 * blocked) we still work, just re-downloading every time.
 */
function openCache() {
	try {
		if (typeof caches === 'undefined') return Promise.resolve(null);
		return caches.open(config.cacheName).catch(function () {
			return null;
		});
	} catch (cause) {
		return Promise.resolve(null);
	}
}

/**
 * Reads a response body into a pre-sized buffer, reporting bytes as they land.
 *
 * Pre-sizing (rather than concatenating chunks at the end) matters at this
 * scale: the naive version would momentarily hold two 427 MB copies.
 */
function drain(body, expected, onProgress) {
	var bytes = new Uint8Array(expected);
	var reader = body.getReader();
	var loaded = 0;

	function step() {
		return reader.read().then(function (result) {
			if (result.done) {
				if (loaded !== expected) {
					throw new Error('expected ' + expected + ' bytes, got ' + loaded);
				}
				return bytes.buffer;
			}
			var value = result.value;
			if (value) {
				if (loaded + value.length > expected) {
					throw new Error('response is larger than the expected ' + expected + ' bytes');
				}
				bytes.set(value, loaded);
				loaded += value.length;
				onProgress(loaded);
			}
			return step();
		});
	}

	return step();
}

/**
 * Fetches one artifact, preferring the cached copy.
 *
 * A cache hit whose size is wrong is deleted rather than trusted: the whole
 * engine is a byte-offset table into these files, so a truncated `.data` would
 * fail in a much more confusing way later.
 */
function loadArtifact(artifact, onProgress) {
	var url = artifact.url;
	var expected = artifact.bytes;
	var cache = null;

	return openCache()
		.then(function (opened) {
			cache = opened;
			if (!cache) return null;
			return cache
				.match(url)
				.then(function (hit) {
					if (!hit) return null;
					return hit.arrayBuffer().then(function (cached) {
						if (cached.byteLength === expected) return cached;
						console.warn(
							'[tts] Cached ' +
								artifact.file +
								' was ' +
								cached.byteLength +
								' B, expected ' +
								expected +
								' B.'
						);
						return cache.delete(url).then(function () {
							return null;
						});
					});
				})
				.catch(function (cause) {
					console.warn('[tts] Could not read ' + artifact.file + ' from the cache.', cause);
					return null;
				});
		})
		.then(function (cached) {
			if (cached) {
				onProgress(expected);
				return cached;
			}

			return fetch(url).then(function (response) {
				if (!response.ok) throw new Error(artifact.file + ': HTTP ' + response.status);

				if (!response.body) {
					return response.arrayBuffer().then(function (whole) {
						if (whole.byteLength !== expected) {
							throw new Error(
								artifact.file + ': expected ' + expected + ' bytes, got ' + whole.byteLength
							);
						}
						onProgress(expected);
						return whole;
					});
				}

				// Tee so the cache write streams straight to disk instead of us
				// holding a second full copy in JS memory.
				var toRead = response.body;
				var cacheWrite = Promise.resolve();
				if (cache) {
					var branches = response.body.tee();
					toRead = branches[0];
					cacheWrite = cache
						.put(
							url,
							new Response(branches[1], { headers: { 'content-type': 'application/octet-stream' } })
						)
						.catch(function (cause) {
							console.warn('[tts] Could not cache ' + artifact.file + '.', cause);
						});
				}

				return drain(toRead, expected, onProgress).then(function (buffer) {
					return cacheWrite.then(function () {
						return buffer;
					});
				});
			});
		});
}

// -- Engine -----------------------------------------------------------------

function reportProgress(file, loaded, total) {
	self.postMessage({ type: 'progress', file: file, loaded: loaded, total: total });
}

function start() {
	var artifacts = config.artifacts;

	// Announce every file up front so the progress bar spans the whole download
	// from the first tick instead of jumping when the second one starts.
	artifacts.forEach(function (artifact) {
		reportProgress(artifact.file, 0, artifact.bytes);
	});

	var loaded = {};

	return artifacts
		.reduce(function (chain, artifact) {
			return chain.then(function () {
				return loadArtifact(artifact, function (bytes) {
					reportProgress(artifact.file, bytes, artifact.bytes);
				}).then(function (buffer) {
					loaded[artifact.file] = buffer;
				});
			});
		}, Promise.resolve())
		.then(function () {
			var wasmBinary = loaded['sherpa-onnx-wasm-main-tts.wasm'];
			var dataPackage = loaded['sherpa-onnx-wasm-main-tts.data'];

			return new Promise(function (resolve, reject) {
				var module = {
					wasmBinary: wasmBinary,
					// Both hooks are the documented way to say "already downloaded".
					getPreloadedPackage: function () {
						return dataPackage;
					},
					locateFile: function (path) {
						return path;
					},
					printErr: function (text) {
						console.warn('[sherpa-onnx]', text);
					},
					onAbort: function (reason) {
						reject(new Error('sherpa-onnx aborted: ' + String(reason)));
					},
					onRuntimeInitialized: function () {
						try {
							if (typeof createOfflineTts !== 'function') {
								throw new Error('sherpa-onnx-tts.js did not define createOfflineTts');
							}
							var engine = createOfflineTts(module, TTS_CONFIG);
							if (!engine.numSpeakers) throw new Error('the model reported zero speakers');
							resolve(engine);
						} catch (cause) {
							reject(cause instanceof Error ? cause : new Error(String(cause)));
						}
					}
				};

				self.Module = module;
				try {
					// Wrapper first: it must define `createOfflineTts` before the glue
					// finishes instantiating and calls `onRuntimeInitialized`.
					self.importScripts.apply(self, config.scripts);
				} catch (cause) {
					reject(cause instanceof Error ? cause : new Error(String(cause)));
				}
			});
		});
}

function ensureStarted() {
	if (tts) return Promise.resolve(tts);
	if (starting) return starting;
	if (!config)
		return Promise.reject(new Error('the speech worker was used before it was configured'));

	var attempt = start();
	starting = attempt;
	attempt.then(
		function (engine) {
			tts = engine;
		},
		function () {
			// A failed start must not be remembered: the download may simply have
			// been interrupted, and the next tap deserves a fresh try. The
			// Emscripten module is not reusable, but `importScripts` of the same
			// URL is a no-op, so a retry re-runs against the cached files.
			if (starting === attempt) starting = null;
		}
	);
	return attempt;
}

/**
 * Whether a clip contains any actual signal. Cheap (one pass, early exit) and
 * NaN-safe: `Math.abs(NaN) > threshold` is false, so an all-NaN buffer fails.
 */
function isAudible(samples) {
	for (var i = 0; i < samples.length; i++) {
		if (Math.abs(samples[i]) > 1e-4) return true;
	}
	return false;
}

function describe(cause) {
	return cause instanceof Error ? cause.message : String(cause);
}

// -- Message loop -----------------------------------------------------------

self.addEventListener('message', function (event) {
	var request = event.data;

	if (request.type === 'init') {
		config = request.config;
		ensureStarted().then(
			function (engine) {
				self.postMessage({
					type: 'ready',
					sampleRate: engine.sampleRate,
					numSpeakers: engine.numSpeakers
				});
			},
			function (cause) {
				self.postMessage({ type: 'failed', message: describe(cause) });
			}
		);
		return;
	}

	if (request.type === 'generate') {
		var id = request.id;
		ensureStarted()
			.then(function (engine) {
				return engine.generate({
					text: request.text,
					sid: request.speakerId,
					speed: request.speed
				});
			})
			.then(
				function (audio) {
					if (!audio.samples.length) throw new Error('the model produced no samples');
					if (!isAudible(audio.samples)) {
						// Hard-won check: the int8 build of this very model returns an
						// array of NaN from ONNX inference (sherpa-onnx#2236), which the
						// WAV encoder would happily turn into a perfectly silent clip.
						// Failing loudly here means the caller falls back to the browser
						// voice instead of the learner hearing nothing at all.
						throw new Error('the model produced silence (all-zero or NaN samples)');
					}
					self.postMessage(
						{ type: 'audio', id: id, samples: audio.samples, sampleRate: audio.sampleRate },
						[audio.samples.buffer]
					);
				},
				function (cause) {
					self.postMessage({ type: 'failed', id: id, message: describe(cause) });
				}
			);
	}
});
