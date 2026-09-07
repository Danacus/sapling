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
import { ready } from '$lib/db/backend';
import type { Backend } from '$lib/db/protocol';
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
		const backend = await ready();
		pushed = await pushPending(backend, SYNC_URL, headers, fetchImpl);
		pulled = await pullPages(backend, SYNC_URL, headers, fetchImpl);
	} catch (error) {
		return record({ ok: false, pushed, pulled, message: messageOf(error) });
	}
	return record({ ok: true, pushed, pulled });
}

/* -------------------------------------------------------------------------- */
/* Push                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Sends every unacknowledged event in log order and stamps the seqs that come
 * back. An event keeps its NULL `seq` until the server has answered for it, so
 * an interrupted push is simply re-sent.
 *
 * Stopping on a short page is safe only because `pendingEvents(limit)` answers
 * with exactly the first `limit` unpushed rows: a row this build cannot read is
 * pushed verbatim like any other, so a page shorter than asked for really does
 * mean the queue is empty rather than that something was filtered out of it.
 */
async function pushPending(
	backend: Backend,
	url: string,
	headers: Record<string, string>,
	fetchImpl: typeof fetch
): Promise<number> {
	let pushed = 0;
	for (;;) {
		const events = await backend.pendingEvents(PUSH_PAGE);
		if (events.length === 0) return pushed;

		const body = await requestJson(
			`${url}/push`,
			{ method: 'POST', headers, body: JSON.stringify({ events }) },
			fetchImpl
		);
		const seqs = readSeqs(body);

		const acknowledged: Record<string, number> = {};
		for (const event of events) {
			if (typeof seqs[event.id] === 'number') acknowledged[event.id] = seqs[event.id];
		}
		// A page nothing could be stamped from would be re-sent forever.
		if (Object.keys(acknowledged).length === 0) {
			throw new Error('The sync server did not accept this device’s changes.');
		}
		pushed += await backend.markPushed(acknowledged);

		if (events.length < PUSH_PAGE) return pushed;
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
	backend: Backend,
	url: string,
	headers: Record<string, string>,
	fetchImpl: typeof fetch
): Promise<number> {
	let cursor = await backend.getPullCursor();
	let applied = 0;

	for (;;) {
		const body = await requestJson(
			`${url}/pull?after=${cursor}&limit=${PULL_PAGE}`,
			{ headers },
			fetchImpl
		);
		const page = readPage(body);
		if (page.events.length === 0) return applied;

		// The cursor moves past every row with a usable `seq`, parseable or not:
		// an event this build cannot read costs one row rather than the whole sync.
		let highest = cursor;
		for (const raw of page.events) {
			const seq = seqOf(raw);
			if (seq !== undefined) highest = Math.max(highest, seq);
		}
		if (highest <= cursor) {
			throw new Error('The sync server sent a page that does not advance the cursor.');
		}

		// Apply strictly before the cursor that covers it: an interruption
		// between the two costs a re-apply, which the log dedupes, while the
		// other order would skip events for good.
		applied += await backend.applyRemote(page.events);
		await backend.setPullCursor(highest);
		cursor = highest;

		if (cursor >= page.latest) return applied;
	}
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
