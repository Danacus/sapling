/**
 * The process-wide backend handle.
 *
 * Boot is lazy and idempotent: the first repository call opens the backend and
 * every later one awaits the same promise. Which backend depends on where the
 * app is running — the database Worker in a browser, the native core in the
 * Tauri desktop shell — and that is the only difference between them: the
 * protocol above and the core below are the same. Nothing here is loaded in
 * node — both transports are reached through a dynamic import, and tests
 * install a backend built over an in-memory database instead.
 */
import { inTauri } from '$lib/platform';

import type { Backend } from './protocol';

/** Shown when the OPFS VFS refuses to open because another tab holds it. */
export const BUSY_MESSAGE = 'Sapling is already open in another tab.';

/**
 * True when a boot failure is the SAH pool's own signal that another tab
 * holds the database file, rather than some other reason the Worker never
 * got as far as opening one (a wasm fetch/instantiate failure, a missing OPFS
 * API, …). Per the File System Access spec, `createSyncAccessHandle` rejects
 * with `NoModificationAllowedError` when its lock cannot be acquired — that
 * name is the one thing every browser's wording of this failure has in
 * common, so it is what `client.ts` matches on rather than guessing from the
 * rest of the message.
 */
export function isSahPoolBusy(reason: string): boolean {
	return reason.includes('NoModificationAllowedError');
}

let pending: Promise<Backend> | undefined;

/**
 * Opens the backend, once.
 *
 * In a browser, rejects with {@link BUSY_MESSAGE} when the OPFS pool is held by
 * another tab. There is no leader election: one tab at a time is the whole
 * design. The desktop shell has no such contest — it owns its file — and no
 * device-id handshake either, because the core there reads its own.
 */
export function ready(): Promise<Backend> {
	pending ??= (async () => {
		if (inTauri()) return (await import('./tauri')).openTauriBackend();
		const [{ openWorkerBackend }, { getDeviceId }] = await Promise.all([
			import('./client'),
			import('$lib/device')
		]);
		return openWorkerBackend(getDeviceId());
	})();
	return pending;
}

/** Installs a backend built elsewhere — an in-memory one, in tests. */
export function setBackendForTesting(backend: Backend | undefined): void {
	pending = backend === undefined ? undefined : Promise.resolve(backend);
}
