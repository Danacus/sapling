/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

/**
 * Offline shell for the installed PWA.
 *
 * The app is local-first: the whole session loop (planning, playing, grading,
 * FSRS scheduling) reads and writes IndexedDB and never touches the
 * network. So caching the static shell is genuinely all that's needed to make
 * an offline launch a *fully working* app, not a degraded one.
 *
 * What still needs network — and already fails gracefully where it lives:
 *   - generating a new batch of challenges (`$lib/llm/generate`)
 *   - the Explain/dispute escalation (`$lib/llm/escalation`)
 *   - the first-ever Kokoro model download (`$lib/tts`), which falls back to
 *     Web Speech and, failing that, to silence — audio never blocks gameplay.
 * Once the models are cached, TTS works offline too.
 *
 * SvelteKit registers this automatically in production builds; `svelte-kit
 * sync` generates the `$service-worker` module below.
 */
import { build, files, version } from '$service-worker';

// `self` in a service worker is a ServiceWorkerGlobalScope, but TS types the
// ambient `self` for the DOM. This cast is the standard SvelteKit workaround.
const sw = self as unknown as ServiceWorkerGlobalScope;

/**
 * Deliberately namespaced. `caches` is shared across the whole origin and the
 * TTS layer keeps its own buckets there (see `$lib/tts/models.ts`).
 */
const CACHE_PREFIX = 'app-shell-';
const CACHE = `${CACHE_PREFIX}${version}`;

/** The SPA fallback (`fallback: 'index.html'`); every navigation resolves to it. */
const SHELL = '/';

/**
 * Cloudflare Pages *consumes* these rather than serving them: `_headers` and
 * friends configure the edge and then 404 as URLs. `cache.addAll` rejects
 * atomically on a single bad response, so leaving them in would make the
 * service worker fail to install on every deploy — and fail silently, since
 * nothing in the app depends on it until the user is offline.
 */
const isPagesConfigFile = (path: string) =>
	/^\/(_headers|_redirects|_routes\.json|_worker\.js)$/.test(path);

/**
 * `build` = Vite's hashed output, `files` = everything in `static/` (which
 * includes the same-origin sherpa TTS worker + glue, ~160KB total, and the
 * manifest and icons). All small, all versioned or stable — precache the lot.
 */
const PRECACHE = [SHELL, ...build, ...files].filter((path) => !isPagesConfigFile(path));

/** The same list as a set: `fetch` asks this question for every request. */
const PRECACHED = new Set(PRECACHE);

sw.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE);
			// Nothing here is stateful, so there's no reason to make the user
			// close every tab before a new deploy takes effect.
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// ⚠️ NEVER sweep `caches.keys()` wholesale here. Cache Storage on this
			// origin also holds `ll-tts-models` (~439MB of Kokoro voices, fetched
			// once from a pinned external mirror) and `ll-tts-audio`. Both belong
			// to the TTS layer, not to the service worker, and deleting them on a
			// deploy would silently force every user through a 439MB re-download
			// on their next lesson. Only ever delete our own `app-shell-` keys.
			for (const key of await caches.keys()) {
				if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Everything cross-origin is none of our business: OpenRouter completions
	// and the TTS model mirror both stream large or auth-bearing responses that
	// the app caches (or deliberately doesn't) on its own terms. Returning
	// without `respondWith` leaves them entirely to the browser.
	if (url.origin !== location.origin) return;

	const isPrecached = PRECACHED.has(url.pathname);

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// Hashed build output and static files: cache-first, no revalidation.
			// A new deploy ships a new `version`, hence a new cache, hence new
			// entries — staleness is impossible by construction.
			//
			// Deliberately excludes navigations even though `SHELL` ('/') is itself
			// precached: without this exclusion every navigation would be answered
			// from cache before the network-first logic below ever runs, and a tab
			// stuck on an old service worker could never recover — not even via a
			// hard reload, which bypasses the browser's HTTP cache but not an active
			// SW's own fetch interception.
			if (isPrecached && request.mode !== 'navigate') {
				const hit = await cache.match(url.pathname);
				if (hit) return hit;
			}

			// Navigations: network-first so a reachable deploy is always the fresh
			// one, falling back to the cached shell. That fallback is the entire
			// offline story — index.html boots the SPA, which then runs from
			// IndexedDB.
			try {
				const response = await fetch(request);
				if (request.mode === 'navigate' && !response.ok) throw new Error('bad response');
				return response;
			} catch (err) {
				const fallback = await cache.match(request.mode === 'navigate' ? SHELL : request);
				if (fallback) return fallback;
				// Rethrowing here rejects `respondWith`'s promise, which Chrome
				// reports as "A ServiceWorker intercepted the request and
				// encountered an unexpected error" — an ordinary failed response
				// says the same thing without the alarming framing.
				return new Response(err instanceof Error ? err.message : 'fetch failed', {
					status: 503,
					statusText: 'Service Unavailable'
				});
			}
		})()
	);
});
