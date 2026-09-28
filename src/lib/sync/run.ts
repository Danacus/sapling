/**
 * The host's half of sync: when, as whom, and what Settings remembers. The
 * cycle, the probe and pairing are Rust's (`core.ts`); this module reads the
 * device's configuration, keeps one cycle at a time, and records the last
 * outcome in `localStorage`.
 *
 * **One cycle at a time.** Several triggers overlap by design, so a later
 * `runSync` joins the cycle already running, and pairing waits its turn behind
 * it rather than racing it with a different phrase.
 */
import type {
	PairOutcome,
	SyncOutcome as CoreOutcome,
	SyncProbeResult
} from '$lib/db/generated/index';
import { getSyncPhrase, isSyncEnabled, setSyncEnabled, setSyncPhrase } from './config';
import { BAD_PHRASE, callSync } from './core';
import { SYNC_URL } from './url';

/** What one cycle did. `skipped`: sync is off here, so nothing ran. Not a failure. */
export type SyncOutcome = CoreOutcome & { skipped?: boolean };

/** The last cycle's result, for Settings to show. */
export interface SyncRecord {
	at: number;
	ok: boolean;
	message: string;
}

const LAST_KEY = 'll.sync.last';

/** Every sync job, chained; a failed one does not wedge the queue. */
let tail: Promise<unknown> = Promise.resolve();
/** The queued or running cycle a later `runSync` joins. */
let joinable: Promise<SyncOutcome> | undefined;

function exclusive<T>(job: () => Promise<T>): Promise<T> {
	const next = tail.then(job, job);
	tail = next.catch(() => undefined);
	return next;
}

function messageOf(error: unknown): string {
	return error instanceof Error && error.message ? error.message : 'Sync failed.';
}

/** Runs a cycle, or joins the one already queued. `fetchImpl` is for tests. */
export function runSync(fetchImpl: typeof fetch = fetch): Promise<SyncOutcome> {
	if (joinable) return joinable;
	const cycle = exclusive(() => cycleNow(fetchImpl)).finally(() => {
		// Guarded so a cycle that outlives its own slot cannot clear a newer one.
		if (joinable === cycle) joinable = undefined;
	});
	joinable = cycle;
	return cycle;
}

async function cycleNow(fetchImpl: typeof fetch): Promise<SyncOutcome> {
	const phrase = getSyncPhrase();
	if (!isSyncEnabled() || !SYNC_URL || !phrase) {
		return { ok: false, skipped: true, pushed: 0, pulled: 0, summary: 'Sync is off.' };
	}
	let outcome: SyncOutcome;
	try {
		outcome = await callSync('runSync', { url: SYNC_URL, phrase }, fetchImpl);
	} catch (error) {
		// The store failed to open: the cycle never started.
		const message = messageOf(error);
		outcome = { ok: false, pushed: 0, pulled: 0, message, summary: message };
	}
	record(outcome);
	return outcome;
}

/**
 * Adopts `raw` as this device's phrase, syncs once, and reports whether a
 * profile came with it. An invalid phrase stores nothing and asks no one.
 */
export async function pairDevice(
	raw: string,
	fetchImpl: typeof fetch = fetch
): Promise<PairOutcome> {
	if (setSyncPhrase(raw) === undefined) return { ok: false, paired: false, message: BAD_PHRASE };
	setSyncEnabled(true);
	const phrase = getSyncPhrase();
	if (!isSyncEnabled() || !SYNC_URL || !phrase) {
		return { ok: false, paired: false, message: 'Could not sync this device.' };
	}
	const url = SYNC_URL;
	return exclusive(async () => {
		try {
			return await callSync('pairDevice', { url, phrase }, fetchImpl);
		} catch (error) {
			return { ok: false, paired: false, message: messageOf(error) };
		}
	});
}

/** Asks the relay whether this device could connect. Never throws. */
export async function probeSync(
	url: string,
	phrase: string,
	fetchImpl: typeof fetch = fetch
): Promise<SyncProbeResult> {
	return callSync('probeSync', { url, phrase }, fetchImpl);
}

/**
 * Remembers the outcome so Settings can show one honest line.
 *
 * `localStorage` rather than the log: it is a device-local fact about the
 * network, not something another device should ever hear about.
 */
function record(outcome: SyncOutcome): void {
	const entry: SyncRecord = { at: Date.now(), ok: outcome.ok, message: outcome.summary };
	try {
		localStorage.setItem(LAST_KEY, JSON.stringify(entry));
	} catch {
		/* ignore: storage unavailable or full */
	}
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
		if (typeof parsed !== 'object' || parsed === null) return undefined;
		const { at, ok, message } = parsed as Record<string, unknown>;
		if (typeof at !== 'number' || typeof ok !== 'boolean' || typeof message !== 'string') {
			return undefined;
		}
		return { at, ok, message };
	} catch {
		return undefined;
	}
}
