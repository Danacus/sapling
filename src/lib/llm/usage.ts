/**
 * Cumulative token-usage counters.
 *
 * The whole point of the batching design is that tokens are scarce, so every
 * real network call is metered. Counters live in `localStorage` (they are a
 * device-level curiosity, not synced data) and every accessor is guarded so the
 * module can be imported from node — tests and SSR included — without throwing.
 *
 * This is the single stateful corner of `$lib/llm`; everything else is pure.
 */

import type { TokenUsage } from './client';

const PROMPT_KEY = 'll.usage.promptTokens';
const COMPLETION_KEY = 'll.usage.completionTokens';
const REQUESTS_KEY = 'll.usage.requests';

/** Lifetime totals across every real (non-mock) completion. */
export interface UsageTotals {
	promptTokens: number;
	completionTokens: number;
	requests: number;
}

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

function readNumber(key: string): number {
	if (!hasStorage()) return 0;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return 0;
		const n = Number.parseInt(raw, 10);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		// Private-mode / disabled-storage browsers throw on access.
		return 0;
	}
}

function writeNumber(key: string, value: number): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(key, String(value));
	} catch {
		/* ignore: storage unavailable or full */
	}
}

function removeKey(key: string): void {
	if (!hasStorage()) return;
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

function sanitize(n: unknown): number {
	return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Adds one completion's usage to the running totals and bumps the request
 * counter. Called from the real client path; mock mode never records.
 */
export function recordUsage(usage: TokenUsage): void {
	if (!hasStorage()) return;
	writeNumber(PROMPT_KEY, readNumber(PROMPT_KEY) + sanitize(usage?.promptTokens));
	writeNumber(COMPLETION_KEY, readNumber(COMPLETION_KEY) + sanitize(usage?.completionTokens));
	writeNumber(REQUESTS_KEY, readNumber(REQUESTS_KEY) + 1);
}

/** Lifetime totals. All zeroes when storage is unavailable or never written. */
export function getUsageTotals(): UsageTotals {
	return {
		promptTokens: readNumber(PROMPT_KEY),
		completionTokens: readNumber(COMPLETION_KEY),
		requests: readNumber(REQUESTS_KEY)
	};
}

/** Forgets the counters. */
export function resetUsage(): void {
	removeKey(PROMPT_KEY);
	removeKey(COMPLETION_KEY);
	removeKey(REQUESTS_KEY);
}
