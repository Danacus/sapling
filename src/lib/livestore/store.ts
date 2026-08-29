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

/**
 * The id of this browser's local store. Constant, and it stays constant even
 * once sync is on.
 *
 * That is worth stating plainly, because the obvious design is the opposite
 * one: derive the store's name from the pairing phrase so that two paired
 * devices share a name. It would be a mistake. `storeId` is what names the
 * database *in OPFS*, so deriving it from the phrase would mean that pairing a
 * device renames its store — which is to say, opens a new, empty one, and
 * leaves everything written before pairing stranded in the old.
 *
 * So local identity and remote identity are separated. Nothing on disk ever
 * moves; what the phrase selects is the *room* the events are relayed through,
 * and `worker/index.ts` does that server-side, where it costs nothing.
 */
const STORE_ID = 'sapling';

let pending: Promise<Store<typeof schema>> | undefined;

/**
 * Creates the store if it does not exist yet, and returns it.
 *
 * Idempotent: concurrent callers share one in-flight promise, so the eight
 * repository calls a page makes on boot do not race to build eight stores.
 *
 * The legacy Dexie migration runs *inside* this promise, before it resolves.
 * That placement is the whole guarantee: every repository function awaits
 * `storeReady()`, so there is no read anywhere in the app that can observe the
 * store before its migrated contents are in it. In particular the layout's own
 * `getProfile()` cannot — and a learner with months of history is never shown
 * the onboarding screen and invited to start again.
 */
export function storeReady(): Promise<Store<typeof schema>> {
	pending ??= (async () => {
		const [{ makeWebAdapter }, { createStorePromise }] = await Promise.all([
			import('./adapter'),
			import('@livestore/livestore')
		]);
		const store = await createStorePromise({
			adapter: makeWebAdapter(),
			schema,
			storeId: STORE_ID
		});
		const { runDexieMigration } = await import('./migrate-dexie');
		await runDexieMigration(store);
		return store;
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
