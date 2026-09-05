import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { describe, expect, it } from 'vitest';

import { loadWasmCore } from './backend.testing';
import { openCore, queryRows } from './host';
import { WasmCore } from './wasm/sapling_core';

/**
 * `CREATE TABLE IF NOT EXISTS` keeps whatever columns a table was created with,
 * so a read table that changed shape has to be rebuilt from the log — and that
 * rebuild must not lose a single event. Opening the core is what does it.
 */
describe('opening the core', () => {
	it('rebuilds a read table left in an older shape, keeping the log', async () => {
		loadWasmCore();
		const sqlite3 = await sqlite3InitModule();
		const db = new sqlite3.oo1.DB(':memory:');

		// A database from before `conversationTurns` carried `at`, with one event
		// already in its log and the version row missing — exactly what an
		// upgraded install looks like on first boot.
		db.exec(`
			CREATE TABLE events (id TEXT PRIMARY KEY, seq INTEGER, type TEXT NOT NULL,
			  at INTEGER NOT NULL, device TEXT NOT NULL, payload TEXT NOT NULL);
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
			CREATE TABLE conversationTurns (conversationId TEXT NOT NULL, idx INTEGER NOT NULL,
			  learner TEXT, teacher TEXT NOT NULL, PRIMARY KEY (conversationId, idx));
			INSERT INTO events (id, seq, type, at, device, payload) VALUES (
			  'e1', 1, 'turnAdded', 5, 'dev',
			  '{"conversationId":"c1","index":0,"teacher":{"role":"teacher","reply":{"text":"hi"},"actions":[]}}');
		`);

		openCore(db, { deviceId: 'dev' });

		expect(
			queryRows<{ at: number }>(db, 'SELECT at FROM conversationTurns WHERE conversationId = ?', [
				'c1'
			])
		).toEqual([{ at: 5 }]);
		expect(queryRows<{ n: number }>(db, 'SELECT count(*) AS n FROM events')).toEqual([{ n: 1 }]);
		expect(
			queryRows<{ value: string }>(db, `SELECT value FROM meta WHERE key = 'derivedSchema'`)
		).toEqual([{ value: String(WasmCore.derivedSchemaVersion()) }]);
	});

	it('leaves a current database alone', async () => {
		loadWasmCore();
		const sqlite3 = await sqlite3InitModule();
		const db = new sqlite3.oo1.DB(':memory:');
		openCore(db, { deviceId: 'dev' });
		db.exec(
			`INSERT INTO items (id, kind, term, meaning, fsrsCard, introducedAt) VALUES (?, ?, ?, ?, ?, ?)`,
			{ bind: ['i1', 'vocab', '木', 'tree', '{}', 1] }
		);

		// A second open at the same version must not drop the row: no event backs
		// it, so a rebuild would lose it.
		openCore(db, { deviceId: 'dev' });
		expect(queryRows<{ n: number }>(db, 'SELECT count(*) AS n FROM items')).toEqual([{ n: 1 }]);
	});
});
