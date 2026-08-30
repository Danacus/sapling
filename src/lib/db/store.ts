/**
 * The process-wide database handle.
 *
 * Repositories are the only callers. `commit` mints an envelope and hands it
 * straight to the log — there is no "write the row, then also append the event"
 * pair to keep in agreement, because the event *is* the write and the read
 * tables are what the materializer makes of it.
 *
 * Boot is lazy and idempotent: the first repository call opens the OPFS Worker
 * and every later one awaits the same promise. Nothing here is loaded in node —
 * the Worker reaches this module through a dynamic import, and tests install a
 * store built over an in-memory database instead.
 */
import type { EventType, PayloadFor, SequencedEvent, SyncEvent } from './events';
import type { SqlOp, SqlParam } from './materialize';
import { getDeviceId, newUuid } from '$lib/device';

/** Shown when the OPFS VFS refuses to open because another tab holds it. */
export const BUSY_MESSAGE = 'Sapling is already open in another tab.';

/** The RPC the OPFS Worker serves; `store.testing.ts` serves the same thing in-process. */
export interface DbClient {
	query<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
	batch(ops: SqlOp[]): Promise<void>;
	ingest(entries: { event: SyncEvent; seq: number | null }[]): Promise<void>;
	importEvents(events: SyncEvent[]): Promise<void>;
}

/** One event to write, before it has an envelope. */
export type Fact = { [T in EventType]: { type: T; payload: PayloadFor<T> } }[EventType];

export interface Store {
	query<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
	batch(ops: SqlOp[]): Promise<void>;
	/** Appends one local fact and materialises it. */
	commit<T extends EventType>(type: T, payload: PayloadFor<T>): Promise<void>;
	/** The same, for a run of facts that belong to one action — a single transaction. */
	commitAll(facts: Fact[]): Promise<void>;
	/** Applies a page pulled from the backend, in arrival order. */
	applyRemote(events: SequencedEvent[]): Promise<void>;
	/** Unions a v3 export into the log and replays everything. */
	importEvents(events: SyncEvent[]): Promise<void>;
}

export function makeStore(client: DbClient): Store {
	function commitAll(facts: Fact[]): Promise<void> {
		if (facts.length === 0) return Promise.resolve();
		const device = getDeviceId();
		const at = Date.now();
		return client.ingest(
			facts.map((fact) => ({
				event: { id: newUuid(), type: fact.type, at, device, payload: fact.payload },
				seq: null
			}))
		);
	}

	return {
		query: (sql, params) => client.query(sql, params),
		batch: (ops) => client.batch(ops),
		commit: (type, payload) => commitAll([{ type, payload } as Fact]),
		commitAll,
		applyRemote: (events) => client.ingest(events.map(({ seq, ...event }) => ({ event, seq }))),
		importEvents: (events) => client.importEvents(events)
	};
}

let pending: Promise<Store> | undefined;

/**
 * Opens the database, once.
 *
 * Rejects with {@link BUSY_MESSAGE} when the OPFS pool is held by another tab.
 * There is no leader election: one tab at a time is the whole design.
 */
export function ready(): Promise<Store> {
	pending ??= (async () => {
		const { openWorkerClient } = await import('./client');
		return makeStore(await openWorkerClient());
	})();
	return pending;
}

/** Installs a store built elsewhere — an in-memory one, in tests. */
export function setStoreForTesting(store: Store | undefined): void {
	pending = store === undefined ? undefined : Promise.resolve(store);
}
