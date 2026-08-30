/**
 * Test-only store construction: the same SQLite build, in memory.
 *
 * `@sqlite.org/sqlite-wasm`'s node entry runs the same WASM as the browser, so
 * these are not mocks — the DDL, the merge rules and the repositories under
 * test are the ones the app ships. Only the transport differs: no Worker, so
 * the RPC is called straight through.
 *
 * Not a `.test.ts` file, so vitest does not try to run it as a suite.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { ingest, insertOnly, openSchema, rebuild, type Sql } from './materialize';
import { makeStore, type DbClient, type Store } from './store';

function localClient(sql: Sql): DbClient {
	return {
		query: <T>(statement: string, params?: (string | number | null)[]) =>
			Promise.resolve(sql.query<T>(statement, params)),
		batch(ops) {
			for (const op of ops) sql.exec(op.sql, op.params);
			return Promise.resolve();
		},
		ingest(entries) {
			for (const entry of entries) ingest(sql, entry.event, entry.seq);
			return Promise.resolve();
		},
		importEvents(events) {
			for (const event of events) insertOnly(sql, event);
			rebuild(sql);
			return Promise.resolve();
		}
	};
}

/** A fresh in-memory store, with the DDL already applied. */
export async function makeTestStore(): Promise<Store> {
	const sqlite3 = await sqlite3InitModule();
	const db = new sqlite3.oo1.DB(':memory:');
	return makeStore(localClient(openSchema(db)));
}
