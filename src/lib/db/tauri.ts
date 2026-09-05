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
 * `@tauri-apps/api` is imported dynamically, and `backend.ts` only imports this
 * module at all when `__TAURI_INTERNALS__` is on the window, so a browser loads
 * neither.
 */
import { backendOver } from './client';
import type { Backend } from './protocol';

export async function openTauriBackend(): Promise<Backend> {
	const { invoke } = await import('@tauri-apps/api/core');
	return backendOver(async (method, args) => {
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
	});
}
