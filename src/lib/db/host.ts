/**
 * The host side of the Rust core: what the wasm build borrows from JavaScript.
 *
 * `crates/sapling-core` is written against a four-line `Sql` seam and owns no
 * database, clock, id generator or calendar. This module lends it all four
 * over sqlite-wasm's synchronous `oo1` API — inside the database Worker in the
 * browser, in-process in node tests — and turns its `dispatch(method, argsJson)`
 * back into the {@link Backend} methods `protocol.ts` names.
 *
 * JSON strings cross the boundary in both directions, on purpose: the core
 * formats every answer as `JSON.stringify` would, so nothing here has to agree
 * with it about how a number prints, and the rows the database hands back go
 * through `JSON.stringify` untouched. An `undefined` answer stays `undefined`
 * — the core returns no string at all — because JSON cannot say it.
 */
import type { Database } from '@sqlite.org/sqlite-wasm';

import { newUuid } from '$lib/device';
import { localDay } from './day';
import { BACKEND_METHODS, type Backend, type BackendMethod, type Direct } from './protocol';
import { WasmCore } from './wasm/sapling_core';

/** What a statement binds: the JSON-shaped scalars the core sends. */
export type SqlParam = string | number | null;

export interface HostOptions {
	/** A `localStorage` fact the Worker cannot read; the window sends it. */
	deviceId: string;
	/** What the core stamps and reports as "now". Left out, the real clock. */
	clock?: () => number;
	/** Event ids. Left out, `crypto.randomUUID`. */
	ids?: () => string;
}

/** Runs one query and returns its rows as objects, as sqlite-wasm types them. */
export function queryRows<T>(db: Database, sql: string, params: SqlParam[] = []): T[] {
	return db.exec(sql, { bind: params, rowMode: 'object', returnValue: 'resultRows' }) as T[];
}

/**
 * Opens the core over an open sqlite-wasm database.
 *
 * The schema is applied here, inside the constructor: a database from an older
 * build has its read tables rebuilt from the log before the first call lands.
 */
export function openCore(db: Database, options: HostOptions): WasmCore {
	const exec = (sql: string, params: string): void => {
		db.exec(sql, { bind: JSON.parse(params) as SqlParam[] });
	};
	const query = (sql: string, params: string): string =>
		JSON.stringify(queryRows(db, sql, JSON.parse(params) as SqlParam[]));
	return new WasmCore(
		options.deviceId,
		exec,
		query,
		localDay,
		options.clock ?? Date.now,
		options.ids ?? newUuid
	);
}

/** The core's `dispatch`, as the synchronous {@link Backend} both the Worker and the test rig wrap. */
export function directOf(core: WasmCore): Direct<Backend> {
	const direct: Partial<Record<BackendMethod, unknown>> = {};
	for (const method of BACKEND_METHODS) {
		direct[method] = (...args: unknown[]): unknown => {
			const answer = core.dispatch(method, JSON.stringify(args));
			return answer === undefined ? undefined : (JSON.parse(answer) as unknown);
		};
	}
	return direct as Direct<Backend>;
}
