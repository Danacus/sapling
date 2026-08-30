/**
 * `runSync()` — one whole cycle: push what this device wrote, pull what the
 * others did, apply it, advance the cursor.
 *
 * The only module in `$lib/sync` that talks to the network, and deliberately
 * framework-free with an injectable `fetch`, so the whole orchestration is
 * node-testable against a fake server.
 *
 * Three properties are load-bearing:
 *
 * - **It never throws.** Sync is optional everywhere; a device offline, a
 *   phrase the server refuses or a backend on fire must leave the app exactly
 *   as it was. Failures come back as a {@link SyncOutcome}.
 * - **Interruption costs a redundant request, never an event.** A push stamps
 *   `seq` only on what the server acknowledged; the cursor advances only after
 *   its page has been applied. Both directions are safe to repeat — the log
 *   unions by event id at both ends.
 * - **One cycle at a time.** Several triggers overlap by design, so a later
 *   caller joins the run already going rather than starting a second one.
 */
import { parseEvent, type SequencedEvent } from '$lib/db/events';
import { LOG_ORDER } from '$lib/db/materialize';
import { ready, type Store } from '$lib/db/store';
import { getSyncPhrase, isSyncEnabled } from './config';
import { SYNC_URL } from './url';

/** What one cycle did. `ok` is the only field a caller has to look at. */
export interface SyncOutcome {
	ok: boolean;
	/** Local events the server acknowledged and stamped with a `seq`. */
	pushed: number;
	/** Events applied from the log — this device's own echoes included. */
	pulled: number;
	/** Learner-facing; present on failure. */
	message?: string;
	/** Sync is off or unconfigured, so the cycle did nothing. Not a failure. */
	skipped?: boolean;
}

/** The last cycle's result, for Settings to show. */
export interface SyncRecord {
	at: number;
	ok: boolean;
	message: string;
}

const PUSH_PAGE = 500;
const PULL_PAGE = 1000;
const LAST_KEY = 'll.sync.last';
const CURSOR_KEY = 'pullCursor';

/** The in-flight cycle, or `undefined` when idle. */
let inFlight: Promise<SyncOutcome> | undefined;

/** Runs a cycle, or joins the one already running. `fetchImpl` is for tests. */
export function runSync(fetchImpl: typeof fetch = fetch): Promise<SyncOutcome> {
	if (inFlight) return inFlight;
	const cycle = syncCycle(fetchImpl).finally(() => {
		// Guarded so a cycle that outlives its own slot cannot clear a newer one.
		if (inFlight === cycle) inFlight = undefined;
	});
	inFlight = cycle;
	return cycle;
}

async function syncCycle(fetchImpl: typeof fetch): Promise<SyncOutcome> {
	const phrase = getSyncPhrase();
	if (!isSyncEnabled() || !SYNC_URL || !phrase) {
		return { ok: false, skipped: true, pushed: 0, pulled: 0 };
	}

	const headers = { Authorization: `Bearer ${phrase}`, 'Content-Type': 'application/json' };
	let pushed = 0;
	let pulled = 0;
	try {
		const store = await ready();
		pushed = await pushPending(store, SYNC_URL, headers, fetchImpl);
		pulled = await pullPages(store, SYNC_URL, headers, fetchImpl);
	} catch (error) {
		return record({ ok: false, pushed, pulled, message: messageOf(error) });
	}
	return record({ ok: true, pushed, pulled });
}

/* -------------------------------------------------------------------------- */
/* Push                                                                        */
/* -------------------------------------------------------------------------- */

interface PendingRow {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: string;
}

/**
 * Sends every `seq IS NULL` row in log order and stamps the seqs that come
 * back. A row keeps its NULL until the server has answered for it, so an
 * interrupted push is simply re-sent.
 */
async function pushPending(
	store: Store,
	url: string,
	headers: Record<string, string>,
	fetchImpl: typeof fetch
): Promise<number> {
	let pushed = 0;
	for (;;) {
		const rows = await store.query<PendingRow>(
			`SELECT id, type, at, device, payload FROM events
			 WHERE seq IS NULL ORDER BY ${LOG_ORDER} LIMIT ${PUSH_PAGE}`
		);
		if (rows.length === 0) return pushed;

		const events = rows.map((row) => ({
			id: row.id,
			type: row.type,
			at: row.at,
			device: row.device,
			payload: JSON.parse(row.payload) as unknown
		}));
		const body = await requestJson(
			`${url}/push`,
			{ method: 'POST', headers, body: JSON.stringify({ events }) },
			fetchImpl
		);
		const seqs = readSeqs(body);

		const ops = rows
			.filter((row) => typeof seqs[row.id] === 'number')
			.map((row) => ({
				sql: 'UPDATE events SET seq = ? WHERE id = ?',
				params: [seqs[row.id], row.id]
			}));
		// A page nothing could be stamped from would be re-sent forever.
		if (ops.length === 0) throw new Error('The sync server did not accept this device’s changes.');
		await store.batch(ops);
		pushed += ops.length;

		if (rows.length < PUSH_PAGE) return pushed;
	}
}

/* -------------------------------------------------------------------------- */
/* Pull                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pulls from the stored cursor until caught up, applying each page as it lands.
 *
 * "Caught up" is `cursor >= latest`, not a short page: the server may answer
 * with fewer events than asked for and still have more.
 */
async function pullPages(
	store: Store,
	url: string,
	headers: Record<string, string>,
	fetchImpl: typeof fetch
): Promise<number> {
	let cursor = await readCursor(store);
	let applied = 0;

	for (;;) {
		const body = await requestJson(
			`${url}/pull?after=${cursor}&limit=${PULL_PAGE}`,
			{ headers },
			fetchImpl
		);
		const page = readPage(body);
		if (page.events.length === 0) return applied;

		let highest = cursor;
		const events: SequencedEvent[] = [];
		for (const raw of page.events) {
			const seq = seqOf(raw);
			if (seq === undefined) continue;
			highest = Math.max(highest, seq);
			// An event this build cannot parse is skipped but still moves the
			// cursor past itself, so it costs one row rather than the whole sync.
			const parsed = parseEvent(raw);
			if (parsed) events.push({ ...parsed, seq });
		}

		if (highest <= cursor) {
			throw new Error('The sync server sent a page that does not advance the cursor.');
		}

		// Apply strictly before the cursor that covers it: an interruption
		// between the two costs a re-apply, which the log dedupes, while the
		// other order would skip events for good.
		if (events.length > 0) await store.applyRemote(events);
		await writeCursor(store, highest);
		cursor = highest;
		applied += events.length;

		if (cursor >= page.latest) return applied;
	}
}

async function readCursor(store: Store): Promise<number> {
	const row = (
		await store.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', [CURSOR_KEY])
	)[0];
	const parsed = row ? Number.parseInt(row.value, 10) : 0;
	return Number.isFinite(parsed) ? parsed : 0;
}

function writeCursor(store: Store, cursor: number): Promise<void> {
	return store.batch([
		{
			sql: `INSERT INTO meta (key, value) VALUES (?, ?)
			      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			params: [CURSOR_KEY, String(cursor)]
		}
	]);
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

async function requestJson(
	url: string,
	init: RequestInit,
	fetchImpl: typeof fetch
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetchImpl(url, init);
	} catch (cause) {
		// Offline, DNS, CORS — `fetch` rejects with no useful distinction.
		throw new Error('Could not reach the sync server.', { cause });
	}
	if (!response.ok) throw new Error(statusMessage(response.status));
	try {
		return await response.json();
	} catch (cause) {
		throw new Error('The sync server sent something unreadable.', { cause });
	}
}

function statusMessage(status: number): string {
	if (status === 401 || status === 403) {
		return 'The sync server rejected the pairing phrase. Check it in Settings.';
	}
	if (status === 429) return 'The sync server is rate-limiting this device. Try again shortly.';
	if (status >= 500) return 'The sync server had a problem on its side. Try again in a minute.';
	return `The sync server refused the request (${status}).`;
}

function readSeqs(body: unknown): Record<string, number> {
	if (!isRecord(body) || !isRecord(body.seqs)) {
		throw new Error('The sync server sent an unexpected response.');
	}
	const seqs: Record<string, number> = {};
	for (const [id, seq] of Object.entries(body.seqs)) {
		if (typeof seq === 'number') seqs[id] = seq;
	}
	return seqs;
}

function readPage(body: unknown): { events: unknown[]; latest: number } {
	if (!isRecord(body) || !Array.isArray(body.events) || typeof body.latest !== 'number') {
		throw new Error('The sync server sent an unexpected response.');
	}
	return { events: body.events, latest: body.latest };
}

/** A usable `seq` off a row, even one too malformed to parse as an event. */
function seqOf(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	const seq = raw.seq;
	return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function messageOf(error: unknown): string {
	return error instanceof Error && error.message ? error.message : 'Sync failed.';
}

/* -------------------------------------------------------------------------- */
/* Last result                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Remembers the outcome so Settings can show one honest line.
 *
 * `localStorage` rather than the log: it is a device-local fact about the
 * network, not something another device should ever hear about.
 */
function record(outcome: SyncOutcome): SyncOutcome {
	const entry: SyncRecord = { at: Date.now(), ok: outcome.ok, message: summaryOf(outcome) };
	try {
		localStorage.setItem(LAST_KEY, JSON.stringify(entry));
	} catch {
		/* ignore: storage unavailable or full */
	}
	return outcome;
}

function summaryOf(outcome: SyncOutcome): string {
	if (!outcome.ok) return outcome.message ?? 'Sync failed.';
	if (outcome.pushed === 0 && outcome.pulled === 0) return 'Already up to date.';
	return `Sent ${outcome.pushed}, received ${outcome.pulled}.`;
}

/** The last cycle's result, or `undefined` if this device has never synced. */
export function lastSyncOutcome(): SyncRecord | undefined {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(LAST_KEY);
	} catch {
		return undefined;
	}
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		const { at, ok, message } = parsed;
		if (typeof at !== 'number' || typeof ok !== 'boolean' || typeof message !== 'string') {
			return undefined;
		}
		return { at, ok, message };
	} catch {
		return undefined;
	}
}
