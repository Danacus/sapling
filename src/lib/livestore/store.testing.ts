/**
 * Test-only store construction.
 *
 * The node adapter runs the same WASM SQLite and the same materializers the
 * browser does, so these are not mocks: a merge rule asserted here is the rule
 * the app will actually run. That is the change the migration buys on the test
 * side — `sync/apply.test.ts` had to assert that a hand-written merge agreed
 * with a separate write path, because the two were different code.
 *
 * Not a `.test.ts` file, so vitest does not try to run it as a suite.
 */
import { makeAdapter } from '@livestore/adapter-node';
import { createStorePromise, type Store } from '@livestore/livestore';

import { schema } from './schema';

let counter = 0;

/** A fresh in-memory store. Each gets its own id so suites cannot bleed into each other. */
export const makeTestStore = (): Promise<Store<typeof schema>> =>
	createStorePromise({
		adapter: makeAdapter({ storage: { type: 'in-memory' } }),
		schema,
		storeId: `test-${++counter}`
	});
