/**
 * One heal-by-reload when a dynamic import fails, and never a loop.
 *
 * A tab left open across a deploy keeps running the old build's JS. When it
 * later dynamically imports one of its own — now deleted — hashed chunks, the
 * SPA fallback rewrites the missing path to `index.html` instead of a 404 and
 * Vite's loader rejects with `vite:preloadError`. Reloading picks up the fresh
 * shell and heals it, since nothing in this app's state lives past the local
 * database.
 *
 * **The reload is safe exactly once, and the guard is what makes that true.**
 * A chunk that fails on *every* load — a 404 that is really a 404, a host whose
 * protocol will not serve that file — reloads, fails again, reloads again, and
 * the app never gets past its own boot.
 *
 * So the flag written before a reload survives the page load that reload
 * produced, and is cleared only when the learner **navigates somewhere else**:
 * `onNavigated` ignores SvelteKit's `enter`, which is the one navigation the
 * reload itself caused. That distinction is the whole fix. The failure this was
 * written for is not raised *during* a navigation — Settings mounts, and only
 * then does an effect import the pinyin chunk and lose — so a guard cleared by
 * any completed navigation, `enter` included, is cleared a heartbeat before the
 * failure it is meant to catch, and the loop survives it. A later navigation is
 * evidence the app works; landing where the reload put us is not.
 *
 * Nothing here calls `preventDefault()` on the event, and that is deliberate:
 * Vite rethrows an unprevented `vite:preloadError`, so the rejection still
 * reaches whoever awaited the import (`loadRomanizer`'s caller, say) rather
 * than resolving it to `undefined`. This guard decides whether to reload; it
 * never decides what the failure means.
 *
 * The log line comes first, before any reload, because on the desktop and
 * Android hosts it is the only place the failing module's URL is ever named —
 * a reload cancels the error the console would otherwise have shown.
 */

/** The slice of `sessionStorage` the guard needs; a test hands it a `Map`. */
export interface GuardStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** Structurally SvelteKit's `AfterNavigate`, without importing `$app` here. */
export interface Navigated {
	type: string;
}

/** Survives the reload it is written for, and nothing beyond this tab. */
const KEY = 'll.reloadedForPreloadError';

/** The initial load — including the one a reload lands on. Never re-arms. */
const ENTER = 'enter';

export interface PreloadReloadGuard {
	/** A dynamic import failed. Logs it, and reloads at most once. */
	onPreloadError(error: unknown): void;
	/** A navigation finished. Re-arms the reload, unless it was the landing. */
	onNavigated(navigation: Navigated): void;
}

export function preloadReloadGuard(host: {
	storage: GuardStorage;
	reload: () => void;
	log: (message: string) => void;
}): PreloadReloadGuard {
	return {
		onPreloadError(error) {
			host.log(`vite:preloadError — ${messageOf(error)}`);
			if (host.storage.getItem(KEY)) return;
			host.storage.setItem(KEY, '1');
			host.reload();
		},
		onNavigated(navigation) {
			if (navigation.type === ENTER) return;
			host.storage.removeItem(KEY);
		}
	};
}

/** The event's payload is the loader's `Error`, whose message carries the URL. */
function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return typeof error === 'string' ? error : String(error);
}
