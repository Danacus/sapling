/**
 * The process-wide backend handle.
 *
 * Boot is lazy and idempotent: the first repository call opens the database
 * Worker and every later one awaits the same promise. Nothing here is loaded in
 * node — the Worker reaches this module through a dynamic import, and tests
 * install a backend built over an in-memory database instead.
 */
import type { Backend } from './protocol';

/** Shown when the OPFS VFS refuses to open because another tab holds it. */
export const BUSY_MESSAGE = 'Sapling is already open in another tab.';

let pending: Promise<Backend> | undefined;

/**
 * Opens the backend, once.
 *
 * Rejects with {@link BUSY_MESSAGE} when the OPFS pool is held by another tab.
 * There is no leader election: one tab at a time is the whole design.
 */
export function ready(): Promise<Backend> {
	pending ??= (async () => {
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
