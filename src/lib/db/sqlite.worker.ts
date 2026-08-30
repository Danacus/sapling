/**
 * The database, in a dedicated module Worker.
 *
 * SQLite lives here because the OPFS SAH-pool VFS is synchronous: it blocks the
 * thread it runs on, which must therefore not be the one painting the UI. The
 * pool needs no COOP/COEP headers (that is the *other* OPFS VFS) and it refuses
 * to install while another tab holds its files — which is reported as one line
 * and no retry.
 *
 * The RPC is deliberately small: read, write a batch, ingest events, import a
 * file. The merge rules are `materialize.ts`, running here unchanged from the
 * copy node tests exercise.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import type { SyncEvent } from './events';
import { ingest, insertOnly, rebuild, sqlFor, type Sql, type SqlOp } from './materialize';
import { DDL } from './schema';

export type WorkerRequest =
	| { id: number; op: 'query'; sql: string; params?: (string | number | null)[] }
	| { id: number; op: 'batch'; ops: SqlOp[] }
	| { id: number; op: 'ingest'; entries: { event: SyncEvent; seq: number | null }[] }
	| { id: number; op: 'importEvents'; events: SyncEvent[] };

export type WorkerResponse =
	| { id: number; rows: unknown[] }
	| { id: number; error: string }
	| { ready: true }
	| { bootError: string };

let sql: Sql | undefined;

/** Runs `body` in one transaction; a throw rolls the whole thing back. */
function transaction(db: Sql, body: () => void): void {
	db.exec('BEGIN');
	try {
		body();
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

function handle(db: Sql, request: WorkerRequest): unknown[] {
	switch (request.op) {
		case 'query':
			return db.query(request.sql, request.params);
		case 'batch':
			transaction(db, () => {
				for (const op of request.ops) db.exec(op.sql, op.params);
			});
			return [];
		case 'ingest':
			transaction(db, () => {
				for (const entry of request.entries) ingest(db, entry.event, entry.seq);
			});
			return [];
		case 'importEvents':
			transaction(db, () => {
				for (const event of request.events) insertOnly(db, event);
				rebuild(db);
			});
			return [];
	}
}

async function boot(): Promise<void> {
	const sqlite3 = await sqlite3InitModule();
	const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'sapling' });
	const db = new pool.OpfsSAHPoolDb('/sapling.db');
	db.exec(DDL);
	sql = sqlFor(db);
}

let bootError: string | undefined;

const booted = boot().then(
	() => postMessage({ ready: true } satisfies WorkerResponse),
	(error: unknown) => {
		bootError = String(error);
		postMessage({ bootError } satisfies WorkerResponse);
	}
);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
	const request = event.data;
	await booted;
	if (!sql) {
		postMessage({ id: request.id, error: bootError ?? 'no database' } satisfies WorkerResponse);
		return;
	}
	try {
		postMessage({ id: request.id, rows: handle(sql, request) } satisfies WorkerResponse);
	} catch (error) {
		postMessage({ id: request.id, error: String(error) } satisfies WorkerResponse);
	}
};
