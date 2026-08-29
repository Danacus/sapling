/**
 * The process-wide LiveStore handle.
 *
 * Every repository function in `$lib/db` awaits {@link storeReady}, so the
 * store is created exactly once and every later call is a resolved promise —
 * the repositories keep their `async` signatures and their callers keep their
 * `await`s, while the queries underneath are synchronous SQLite.
 *
 * Boot happens in `src/routes/+layout.svelte`, not lazily on first use. That is
 * a deliberate constraint rather than a convenience: the service worker adopts
 * `/_app/immutable/**` into its cache *on first fetch*, so a learner who
 * installs the PWA, never opens a lesson and then goes offline would otherwise
 * have no cached leader worker and no data layer at all.
 */
import type { Store } from '@livestore/livestore';

import { schema } from './schema';

/** The id of this learner's single local store. Sync would make it per-user. */
const STORE_ID = 'sapling';

let pending: Promise<Store<typeof schema>> | undefined;

/**
 * Creates the store if it does not exist yet, and returns it.
 *
 * Idempotent: concurrent callers share one in-flight promise, so the eight
 * repository calls a page makes on boot do not race to build eight stores.
 */
export function storeReady(): Promise<Store<typeof schema>> {
	pending ??= (async () => {
		const [{ makeWebAdapter }, { createStorePromise }] = await Promise.all([
			import('./adapter'),
			import('@livestore/livestore')
		]);
		return createStorePromise({ adapter: makeWebAdapter(), schema, storeId: STORE_ID });
	})();
	return pending;
}

/**
 * Installs a store built elsewhere — the node adapter, in tests.
 *
 * This is what makes the repository layer testable at all. It used to carry a
 * comment explaining that its functions were *not* unit-tested because
 * IndexedDB does not exist in node; the node adapter runs the same WASM SQLite
 * and the same materializers as the browser, so that exemption has expired.
 */
export function setStoreForTesting(store: Store<typeof schema> | undefined): void {
	pending = store === undefined ? undefined : Promise.resolve(store);
}
