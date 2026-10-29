/**
 * Device-local Taal settings, under the `ll.*` convention like sync's.
 *
 * The connect code carries a secret (it lets anyone holding it add study time
 * to the learner's Taal challenge), so it lives in `localStorage` and never
 * in the store or the JSON export. Every accessor is wrapped: private-mode
 * browsers throw on `localStorage`, and failing here must not take the app
 * down over an optional leaderboard.
 *
 * Three keys:
 *
 * - `ll.taal.code` — the code as pasted, trimmed.
 * - `ll.taal.through` — the push watermark, **per code and per profile**: the
 *   `now` of the last push that landed whole. Per profile because the core's
 *   `studySessions` covers the active profile only, so one watermark moved by
 *   a push of one language would skip the other's hours. It is stored beside
 *   the code it belongs to and read only for that code, so changing or clearing
 *   the code starts over with a full backfill.
 * - `ll.taal.last` — the last push's outcome, for Settings' status line.
 */
import { isTaalCode } from './core';

const CODE_KEY = 'll.taal.code';
const THROUGH_KEY = 'll.taal.through';
const LAST_KEY = 'll.taal.last';

function read(key: string): string | undefined {
	if (typeof localStorage === 'undefined') return undefined;
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		return undefined;
	}
}

function write(key: string, value: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore: storage unavailable or full */
	}
}

function remove(key: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

function readJson(key: string): Record<string, unknown> | undefined {
	const raw = read(key);
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === 'object' && parsed !== null
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** The stored code, or `undefined` when there is none (or it is junk). */
export function getTaalCode(): string | undefined {
	const code = read(CODE_KEY)?.trim();
	return code && isTaalCode(code) ? code : undefined;
}

/**
 * Stores a pasted code and starts its watermark over. Answers the code as
 * stored, or `undefined` when it is not a code (nothing is stored then).
 */
export function setTaalCode(raw: string): string | undefined {
	const code = raw.trim();
	if (!isTaalCode(code)) return undefined;
	if (code !== getTaalCode()) {
		remove(THROUGH_KEY);
		remove(LAST_KEY);
	}
	write(CODE_KEY, code);
	return getTaalCode() === code ? code : undefined;
}

/** Disconnects: forgets the code, its watermark and its last outcome. */
export function clearTaalCode(): void {
	remove(CODE_KEY);
	remove(THROUGH_KEY);
	remove(LAST_KEY);
}

/** How far the last whole push for `code` and `profile` got, if any. */
export function getPushedThrough(code: string, profile: string): number | undefined {
	const stored = readJson(THROUGH_KEY);
	if (stored?.code !== code) return undefined;
	const profiles = stored.profiles as Record<string, unknown> | undefined;
	const through = profiles?.[profile];
	return typeof through === 'number' && Number.isFinite(through) ? through : undefined;
}

export function setPushedThrough(code: string, profile: string, through: number): void {
	const stored = readJson(THROUGH_KEY);
	const profiles =
		stored?.code === code && typeof stored.profiles === 'object' && stored.profiles !== null
			? (stored.profiles as Record<string, number>)
			: {};
	write(THROUGH_KEY, JSON.stringify({ code, profiles: { ...profiles, [profile]: through } }));
}

/** What Settings shows: the last push, and when one last landed. */
export interface TaalRecord {
	at: number;
	status: 'ok' | 'refused' | 'failed' | 'invalid';
	message: string;
	/** When a push last landed whole, kept across failures. */
	okAt?: number;
}

export function lastTaalOutcome(): TaalRecord | undefined {
	const stored = readJson(LAST_KEY);
	if (!stored) return undefined;
	const { at, status, message, okAt } = stored;
	if (
		typeof at !== 'number' ||
		typeof message !== 'string' ||
		(status !== 'ok' && status !== 'refused' && status !== 'failed' && status !== 'invalid')
	) {
		return undefined;
	}
	return { at, status, message, ...(typeof okAt === 'number' ? { okAt } : {}) };
}

export function recordTaalOutcome(record: Omit<TaalRecord, 'okAt'>): void {
	const okAt = record.status === 'ok' ? record.at : lastTaalOutcome()?.okAt;
	write(LAST_KEY, JSON.stringify({ ...record, ...(okAt === undefined ? {} : { okAt }) }));
}
