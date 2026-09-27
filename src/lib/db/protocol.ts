/**
 * The domain-level protocol between the app and its backend.
 *
 * {@link Backend} is the whole surface the window thread may ask of persistence:
 * every method speaks `$lib/types`, none speaks SQL. The Rust core
 * (`crates/sapling-db`, compiled to wasm) implements it beside SQLite —
 * inside the database Worker in the browser, in-process in node tests, both
 * through `host.ts` — and `client.ts` forwards it over `postMessage`. Fixing
 * the boundary here, rather than at the SQL, is what let the implementation
 * change language without the app noticing, and is what would let it change
 * transport (a native shell, a remote host) the same way.
 *
 * The interface and {@link BACKEND_METHODS} are generated from the method table
 * in `crates/sapling-protocol` (`pnpm core:types`), the same list its
 * `dispatch` is built from, so the two ends cannot disagree about a name, an
 * argument or an answer. Adding a method is one entry in that table. This
 * module keeps the transport's own types: the synchronous {@link Direct} form,
 * the request and the Worker's messages.
 */
import { BACKEND_METHODS, type Backend } from './generated/backend';

export { BACKEND_METHODS, EXPORT_VERSION, type Backend } from './generated/backend';
export type {
	ConversationSummary,
	DailyActivity,
	ExportEnvelope,
	LanguageProfile
} from './generated/index';

export type BackendMethod = (typeof BACKEND_METHODS)[number];

export function isBackendMethod(name: string): name is BackendMethod {
	return (BACKEND_METHODS as readonly string[]).includes(name);
}

/**
 * The same interface answering synchronously — what runs beside SQLite, where
 * every statement is blocking anyway and a method is one transaction.
 */
export type Direct<B> = {
	[M in keyof B]: B[M] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never;
};

/** Wraps a direct implementation so it satisfies {@link Backend} in-process. */
export function promised(direct: Direct<Backend>): Backend {
	const backend: Partial<Record<BackendMethod, unknown>> = {};
	for (const method of BACKEND_METHODS) {
		const fn = direct[method] as (...args: unknown[]) => unknown;
		backend[method] = async (...args: unknown[]) => fn(...args);
	}
	return backend as Backend;
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                 */
/* -------------------------------------------------------------------------- */

/** One call, addressed; `args` is typed by the method it names. */
export type BackendRequest = {
	[M in BackendMethod]: { id: number; method: M; args: Parameters<Backend[M]> };
}[BackendMethod];

/**
 * Answers one request. The request's `method` and `args` agree by construction;
 * the cast is because the type system cannot correlate them across the union.
 */
export function dispatch(direct: Direct<Backend>, request: BackendRequest): unknown {
	const fn = direct[request.method] as (...args: unknown[]) => unknown;
	return fn(...request.args);
}

/** What the window sends the Worker: the device it runs on, then calls. */
export type WorkerInbound = { init: { deviceId: string } } | BackendRequest;

/** What comes back: boot outcome once, then one answer per request. */
export type WorkerOutbound =
	| { ready: true }
	| { bootError: string }
	| { id: number; result: unknown }
	| { id: number; error: string };
