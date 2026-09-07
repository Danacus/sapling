/**
 * The reload guard, which exists to reload exactly once.
 *
 * It lives in a module rather than in `+layout.svelte` for this test: the suite
 * is node-environment with no DOM, and what is worth pinning here is an
 * ordering — which navigations re-arm the reload and which do not. Both bugs
 * this was written for are cases of clearing the flag too early: the layout
 * used to clear it as its script ran, and clearing it on the `enter` the reload
 * itself lands on is the same mistake one tick later. Either way a settings
 * chunk that fails on every load reloads forever, which is what an Android
 * build did.
 */

import { describe, expect, it } from 'vitest';

import { preloadReloadGuard, type GuardStorage } from './preload-reload';

/** `sessionStorage`'s three methods over a `Map`. */
function fakeStorage(): GuardStorage {
	const entries = new Map<string, string>();
	return {
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		removeItem: (key) => void entries.delete(key)
	};
}

/** A guard plus the log lines and reloads it produced, in the order it made them. */
function harness() {
	const events: string[] = [];
	const guard = preloadReloadGuard({
		storage: fakeStorage(),
		reload: () => void events.push('reload'),
		log: (message) => void events.push(`log: ${message}`)
	});
	const reloads = () => events.filter((event) => event === 'reload').length;
	return { guard, events, reloads };
}

const failed = new Error(
	'Failed to fetch dynamically imported module: http://tauri.localhost/_app/immutable/chunks/zh.DEADBEEF.js'
);

describe('preloadReloadGuard', () => {
	it('reloads once for a failed dynamic import', () => {
		const { guard, reloads } = harness();

		guard.onPreloadError(failed);

		expect(reloads()).toBe(1);
	});

	it('names the failing module, and names it before it reloads', () => {
		const { guard, events } = harness();

		guard.onPreloadError(failed);

		expect(events[0]).toContain('zh.DEADBEEF.js');
		expect(events[1]).toBe('reload');
	});

	it('does not reload again while the guard stands', () => {
		const { guard, reloads } = harness();

		guard.onPreloadError(failed);
		guard.onPreloadError(failed);
		guard.onPreloadError(failed);

		expect(reloads()).toBe(1);
	});

	it('still logs the failures it refuses to reload for', () => {
		const { guard, events } = harness();

		guard.onPreloadError(failed);
		guard.onPreloadError(failed);

		expect(events.filter((event) => event.startsWith('log:'))).toHaveLength(2);
	});

	// The loop the guard exists for: the reload lands, the page mounts, and the
	// same import fails again a moment later.
	it('does not re-arm on the page load the reload itself produced', () => {
		const { guard, reloads } = harness();

		guard.onPreloadError(failed);
		guard.onNavigated({ type: 'enter' });
		guard.onPreloadError(failed);

		expect(reloads()).toBe(1);
	});

	it('re-arms once the learner navigates somewhere', () => {
		const { guard, reloads } = harness();

		guard.onPreloadError(failed);
		guard.onNavigated({ type: 'enter' });
		guard.onNavigated({ type: 'link' });
		guard.onPreloadError(failed);

		expect(reloads()).toBe(2);
	});

	it('reads a non-Error payload rather than dropping it', () => {
		const { guard, events } = harness();

		guard.onPreloadError('unknown error occurred while fetching the script');

		expect(events[0]).toContain('unknown error occurred');
	});
});
