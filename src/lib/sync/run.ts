/**
 * `runSync()` — one whole sync cycle: push the outbox, pull what the other
 * devices wrote, apply it, advance the cursor (docs/sync.md §6, §9).
 *
 * This is the only module in `$lib/sync` that talks to the network, and it is
 * deliberately framework-free — no Svelte, no stores, an injectable `fetch` (the
 * `$lib/llm` house rule) — so the whole orchestration is node-testable against a
 * fake server.
 *
 * Three properties are load-bearing, and every loop below is written to keep
 * them:
 *
 * - **Never throws.** Sync is the audio layer of networking (§1): a device with
 *   no connection, a wrong key or a server on fire must keep playing exactly as
 *   before. Every failure comes back as a {@link SyncOutcome} with an error
 *   message the Settings card can show, and nothing else.
 * - **Interruption-safe in both halves.** The outbox drains only rows the server
 *   answered 2xx to; the cursor advances only *after* a batch has been applied.
 *   Both directions therefore cost at most a redundant re-send on the next
 *   attempt — pushes dedupe by event id server-side, applies are idempotent by
 *   construction (`./apply`).
 * - **One cycle at a time.** Three call sites fire this (Settings, after a
 *   session banks, on app load) and two of them routinely overlap; a
 *   module-level single-flight guard makes the second caller share the first
 *   cycle rather than double-push it.
 */

import { drainOutbox, getSyncState, peekOutbox, setSyncState } from '$lib/db';
import { applyRemoteBatch } from './apply';
import { getDeviceId, getSyncKey, getSyncServer, syncEnabled } from './config';
import { storedSyncEventSchema, SYNC_LIMITS, type StoredSyncEvent } from './events';
import { runGenesis } from './genesis';

/** What one cycle did. `ok` is the only field the caller has to look at. */
export interface SyncOutcome {
	/** True when push, pull and apply all completed. */
	ok: boolean;
	/** Events handed to the server and dropped from the outbox. */
	pushed: number;
	/** Remote events applied — own-device echoes and invalid rows excluded. */
	pulled: number;
	/** Present when `ok` is false and something actually went wrong; UI-ready. */
	error?: string;
	/**
	 * True when sync is not configured and the cycle did nothing at all. Not a
	 * failure: `ok` is false because nothing synced, but there is nothing to
	 * report to the learner either (the app-load trigger fires on every device,
	 * most of which will never have a server).
	 */
	skipped?: boolean;
}

/** One pull asks for the protocol maximum; the server clamps anything larger (§6). */
const PULL_PAGE_SIZE = SYNC_LIMITS.maxEventsPerRequest;

/** The in-flight cycle, or `null` when idle. See the single-flight note above. */
let inFlight: Promise<SyncOutcome> | null = null;

/**
 * Runs a sync cycle, or joins the one already running.
 *
 * `fetchImpl` exists for tests; production callers pass nothing.
 */
export function runSync(fetchImpl: typeof fetch = fetch): Promise<SyncOutcome> {
	if (inFlight) return inFlight;
	const cycle = syncCycle(fetchImpl).finally(() => {
		// Guarded, so a cycle that somehow outlives its own slot cannot clear a
		// newer one.
		if (inFlight === cycle) inFlight = null;
	});
	inFlight = cycle;
	return cycle;
}

async function syncCycle(fetchImpl: typeof fetch): Promise<SyncOutcome> {
	const server = getSyncServer();
	const key = getSyncKey();
	// `syncEnabled()` is exactly "both of these are set"; re-checking them here
	// is what narrows the types, not a second opinion.
	if (!syncEnabled() || !server || !key) return { ok: false, skipped: true, pushed: 0, pulled: 0 };

	const endpoint = `${server}/v1/events`;
	const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

	let pushed = 0;
	let pulled = 0;
	try {
		// Everything that could fail lives inside this block, the device-id read
		// included — `runSync` promises an outcome, never a rejection.
		const device = getDeviceId();
		// Genesis first: on the first sync of a device that has been learning
		// offline, the outbox is empty until this back-fills it (§5). It is a
		// no-op on every later cycle.
		await runGenesis();
		pushed = await pushOutbox(endpoint, headers, device, fetchImpl);
		pulled = await pullEvents(endpoint, headers, device, fetchImpl);
		await setSyncState('lastSync', Date.now());
	} catch (error) {
		return { ok: false, pushed, pulled, error: messageOf(error) };
	}
	return { ok: true, pushed, pulled };
}

/* -------------------------------------------------------------------------- */
/* Push                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Drains the outbox in batches, oldest first, and returns how many events left.
 *
 * The peek/push/drain order is the whole interruption story: a batch that the
 * server never answered stays in the outbox and is re-sent next time, and a
 * batch it answered twice is deduped by event id server-side.
 */
async function pushOutbox(
	endpoint: string,
	headers: Record<string, string>,
	device: string,
	fetchImpl: typeof fetch
): Promise<number> {
	let pushed = 0;
	let lastDrained = 0;

	for (;;) {
		const rows = await peekOutbox(SYNC_LIMITS.maxEventsPerRequest);
		if (rows.length === 0) return pushed;

		const seqs = rows.map((row) => row.seq).filter((seq): seq is number => seq !== undefined);
		await requestJson(
			endpoint,
			{
				method: 'POST',
				headers,
				// The body-level `device` is only "who is pushing"; each event
				// carries its own, which is the authoritative one (§6).
				body: JSON.stringify({ device, events: rows.map((row) => row.event) })
			},
			fetchImpl
		);

		await drainOutbox(seqs);
		pushed += rows.length;

		// A short batch means the outbox is empty. The `lastDrained` guard is
		// defensive: a drain that deleted nothing would otherwise re-push the
		// same batch forever.
		const highest = seqs.length > 0 ? Math.max(...seqs) : 0;
		if (rows.length < SYNC_LIMITS.maxEventsPerRequest || highest <= lastDrained) return pushed;
		lastDrained = highest;
	}
}

/* -------------------------------------------------------------------------- */
/* Pull                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Pulls from the stored cursor until caught up with the server's `latest`,
 * applying each page as it arrives, and returns how many events were applied.
 *
 * Pagination is driven by `latest`, not by page size: the server may answer with
 * fewer events than asked for and still have more (§6), so "am I done?" is
 * `cursor >= latest` and nothing else.
 */
async function pullEvents(
	endpoint: string,
	headers: Record<string, string>,
	device: string,
	fetchImpl: typeof fetch
): Promise<number> {
	let cursor = (await getSyncState<number>('cursor')) ?? 0;
	let applied = 0;

	for (;;) {
		const body = await requestJson(
			`${endpoint}?after=${cursor}&limit=${PULL_PAGE_SIZE}`,
			{ headers },
			fetchImpl
		);
		const page = readPage(body);
		if (page.events.length === 0) return applied;

		let highest = cursor;
		const batch: StoredSyncEvent[] = [];
		for (const raw of page.events) {
			const parsed = storedSyncEventSchema.safeParse(raw);
			if (!parsed.success) {
				// Drop it, don't fail the sync (§1) — but still let its `seq`
				// move the cursor, or every future pull re-reads the same bad
				// event. A row too malformed to even have a seq is skipped here
				// and caught by the no-progress check below.
				highest = Math.max(highest, seqOf(raw) ?? highest);
				continue;
			}
			highest = Math.max(highest, parsed.data.seq);
			// This device's own events come back in every pull; §4 skips them —
			// they were applied locally at write time.
			if (parsed.data.device !== device) batch.push(parsed.data);
		}

		if (highest <= cursor) {
			// Nothing in the page can move the cursor, so asking again would
			// fetch the same page forever. Stop, and let the next sync retry.
			throw new Error('The sync server sent a page that does not advance the cursor.');
		}

		if (batch.length > 0) await applyRemoteBatch(batch);
		// Cursor strictly after apply (§6): an interruption between the two
		// costs a re-apply, which is idempotent, while the other order would
		// skip events silently and lose them forever.
		await setSyncState('cursor', highest);
		cursor = highest;
		applied += batch.length;

		if (cursor >= page.latest) return applied;
	}
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One request, with every failure mode turned into an `Error` carrying a
 * message the Settings card can show verbatim.
 */
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
		return 'The sync server rejected the key. Check it in Settings.';
	}
	if (status === 429) return 'The sync server is rate-limiting this device. Try again shortly.';
	if (status >= 500) return 'The sync server had a problem on its side. Try again in a minute.';
	return `The sync server refused the request (${status}).`;
}

/** The pull response, shape-checked. Individual events are validated per event. */
function readPage(body: unknown): { events: unknown[]; latest: number } {
	if (!isRecord(body) || !Array.isArray(body.events) || typeof body.latest !== 'number') {
		throw new Error('The sync server sent an unexpected response.');
	}
	return { events: body.events, latest: body.latest };
}

/** A usable `seq` off an otherwise invalid event, so the cursor can step past it. */
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
