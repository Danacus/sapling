/**
 * Test-only backend construction: the same SQLite build, in memory.
 *
 * `@sqlite.org/sqlite-wasm`'s node entry runs the same WASM as the browser, so
 * these are not mocks — the DDL, the merge rules and the `core.ts` under test
 * are the ones the app ships. Only the transport differs: no Worker, so each
 * method is called straight through.
 *
 * Not a `.test.ts` file, so vitest does not try to run it as a suite.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { getDeviceId } from '$lib/device';
import { makeCore, type Core, type Fact } from './core';
import type { EventType, PayloadFor } from './events';
import { openSchema } from './materialize';
import { promised, type Backend } from './protocol';

/** The backend, plus the core's seeding and inspection hooks made async to match. */
export interface TestBackend extends Backend {
	commit<T extends EventType>(type: T, payload: PayloadFor<T>): Promise<void>;
	commitAll(facts: Fact[]): Promise<void>;
	query<T>(sql: string, params?: (string | number | null)[]): Promise<T[]>;
	/** The core itself, for a test that wants to reach past the protocol. */
	core: Core;
}

/**
 * A fresh in-memory backend, with the DDL already applied.
 *
 * `clock` pins what the core stamps and reports as "now"; leave it out and the
 * core reads the real clock, as the app does.
 */
export async function makeTestBackend(
	deviceId: string = getDeviceId(),
	clock?: () => number
): Promise<TestBackend> {
	const sqlite3 = await sqlite3InitModule();
	const db = new sqlite3.oo1.DB(':memory:');
	const core = makeCore(openSchema(db), deviceId, clock);
	return {
		...promised(core),
		commit: async (type, payload) => core.commit(type, payload),
		commitAll: async (facts) => core.commitAll(facts),
		query: async (sql, params) => core.query(sql, params),
		core
	};
}
