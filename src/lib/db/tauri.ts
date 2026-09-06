/**
 * The window's {@link Backend} inside the Tauri desktop shell.
 *
 * Same protocol, different transport: instead of `postMessage` to a Worker that
 * runs the core compiled to wasm over sqlite-wasm in OPFS, one `invoke` to the
 * native core (`crates/sapling-desktop`) over a SQLite file. The wire is the
 * one `host.ts` already uses on the wasm side — `dispatch(method, argsJson)`
 * in, a JSON string or nothing out — so this module parses answers exactly as
 * `directOf` does and neither end learns which host it is talking to.
 *
 * There is no `init` handshake here. The device id is a `localStorage` fact the
 * *Worker* cannot read, which is why the browser sends it; the desktop core
 * reads its own from a file beside the database, so nothing has to be handed
 * over before the first call.
 *
 * There is no `ready`/`bootError` message either. The native host keeps the
 * reason its file would not open and answers it to every command, so the
 * open here is one cheap read: if that rejects, the backend never resolves
 * and the layout shows the same boot-error screen the Worker's `bootError`
 * reaches, rather than a spinner that ends in a rejected `getProfile`.
 *
 * **The order of calls is this module's job, and it is the one thing the two
 * transports do not share.** The Worker's queue is a message queue: two calls
 * posted without awaiting are delivered and run first-in-first-out, so a write
 * fired and forgotten is on disk before the read that follows it. The desktop
 * commands are `async` and run on Tauri's blocking pool (see the crate root),
 * where two overlapping calls reach the core in whatever order their threads
 * get scheduled — so a caller that does not await could read state its own
 * write had not landed yet. The fix stays here rather than in the host, which
 * has no way to know what order the window meant: every `invoke` is chained
 * behind the previous one, which restores exactly the guarantee the Worker
 * already gave. It costs one round trip's worth of pipelining and no
 * throughput — the core is one thread and runs one call at a time regardless.
 * A rejected call must not wedge the queue, so what the next call waits on is
 * the settling, not the value.
 *
 * `@tauri-apps/api` is imported dynamically, and `backend.ts` only imports this
 * module at all when `__TAURI_INTERNALS__` is on the window, so a browser loads
 * neither.
 */
import { backendOver } from './client';
import type { Backend } from './protocol';

export async function openTauriBackend(): Promise<Backend> {
	const { invoke } = await import('@tauri-apps/api/core');

	// The tail of the chain described above. It never rejects: a failed call is
	// caught here so the next one still runs, while the caller gets the
	// rejection untouched.
	let last: Promise<unknown> = Promise.resolve();
	const inOrder = <T>(call: () => Promise<T>): Promise<T> => {
		const result = last.then(call);
		last = result.catch(() => undefined);
		return result;
	};

	const backend = backendOver((method, args) =>
		inOrder(async () => {
			// A `void` method and a read of a missing row answer nothing at all;
			// JSON cannot say `undefined`, so the core sends no string and the
			// command's `Option<String>` arrives as `null`.
			const answer = await invoke<string | null>('dispatch', {
				method,
				args: JSON.stringify(args)
			}).catch((error: unknown) => {
				// A command's `Err(String)` rejects with the bare string; the rest of
				// the app expects the same `Error` the Worker transport throws.
				throw new Error(String(error));
			});
			return answer === null ? undefined : (JSON.parse(answer) as unknown);
		})
	);
	// The probe: the smallest read there is, and the call whose `Err` carries
	// the open failure when there is one.
	await backend.poolSize();
	return backend;
}
