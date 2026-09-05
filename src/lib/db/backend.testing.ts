/**
 * Test-only backend construction: the same core, the same SQLite build, in memory.
 *
 * `@sqlite.org/sqlite-wasm`'s node entry runs the same WASM as the browser, and
 * `pnpm core:wasm` writes the same Rust core the Worker loads, so these are not
 * mocks — the DDL, the merge rules and every `Backend` method under test are the
 * ones the app ships. Only the transport differs: no Worker, so each method is
 * called straight through `host.ts`.
 *
 * Not a `.test.ts` file, so vitest does not try to run it as a suite.
 */
import { readFileSync } from 'node:fs';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { getDeviceId } from '$lib/device';
import type { EventType, Fact, PayloadFor } from './events';
import { directOf, openCore, queryRows, type SqlParam } from './host';
import { promised, type Backend, type Direct } from './protocol';
import { initSync } from './wasm/sapling_core';

/** The backend, plus the core's seeding and inspection hooks made async to match. */
export interface TestBackend extends Backend {
	/** Appends one local fact, as the app's own writes do. */
	commit<T extends EventType>(type: T, payload: PayloadFor<T>): Promise<void>;
	/** The same, for a run of facts in one transaction. */
	commitAll(facts: Fact[]): Promise<void>;
	/** A raw read of a table the protocol does not expose. */
	query<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
	/** The same backend answering synchronously — for a test of the protocol plumbing itself. */
	direct: Direct<Backend>;
}

let loaded = false;

/**
 * Instantiates the wasm core from the file `pnpm core:wasm` wrote, once per
 * module — the browser fetches the same bytes by URL.
 */
export function loadWasmCore(): void {
	if (loaded) return;
	const bytes = readFileSync(new URL('./wasm/sapling_core_bg.wasm', import.meta.url));
	initSync({ module: bytes as BufferSource });
	loaded = true;
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
	loadWasmCore();
	const sqlite3 = await sqlite3InitModule();
	const db = new sqlite3.oo1.DB(':memory:');
	const core = openCore(db, { deviceId, clock });
	const direct = directOf(core);
	return {
		...promised(direct),
		direct,
		commit: async (type, payload) => core.commitAll(JSON.stringify([{ type, payload }])),
		commitAll: async (facts) => core.commitAll(JSON.stringify(facts)),
		query: async <T>(sql: string, params: SqlParam[] = []) => queryRows<T>(db, sql, params)
	};
}
