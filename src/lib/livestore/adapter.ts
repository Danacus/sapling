/**
 * The browser adapter, isolated behind a module boundary on purpose.
 *
 * The two `?worker` imports below are what make this file browser-only: Vite
 * turns them into worker constructors that cannot be evaluated in node. That
 * matters because `$lib/db` now leads here, and `src/lib/session/engine.test.ts`
 * imports the real `$lib/db` module graph rather than mocking it. So
 * `store.ts` reaches this file through a dynamic `import()` and node never
 * loads it.
 *
 * Persistence is OPFS. The shared worker is what elects a single leader across
 * tabs; on browsers without `SharedWorker` the adapter degrades to single-tab
 * by itself, which is the behaviour we want anyway — one learner, one tab, and
 * a second tab that still works rather than refusing to open.
 */
import { makePersistedAdapter } from '@livestore/adapter-web';
import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker';

import LiveStoreWorker from './livestore.worker?worker';

export function makeWebAdapter() {
	return makePersistedAdapter({
		worker: LiveStoreWorker,
		sharedWorker: LiveStoreSharedWorker,
		storage: { type: 'opfs' }
	});
}
