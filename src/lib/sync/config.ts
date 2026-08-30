/**
 * Device-local sync settings.
 *
 * Same rules as `db/settings.ts` and `ui/prefs.ts`, and for the same reason:
 * the pairing phrase is a secret, so it lives in `localStorage` under the
 * `ll.*` convention, never in the store and therefore never in the JSON export.
 * A backup file that carried the phrase would hand every reader of it the whole
 * library. Every accessor is wrapped, because private-mode browsers throw on
 * `localStorage` and failing here would take the app down over a preference.
 *
 * Two keys, and the split between them matters:
 *
 * - `ll.sync.phrase` is *identity*. Once minted it should outlive everything —
 *   it names the room, so replacing it re-pairs the device.
 * - `ll.sync.enabled` is the *switch*. Turning sync off keeps the phrase, so
 *   turning it back on rejoins the same room rather than stranding the device
 *   in a fresh empty one.
 */
import { isValidPhrase, mintPhrase, normalizePhrase } from './phrase';
import { SYNC_URL } from './url';

const PHRASE_KEY = 'll.sync.phrase';
const ENABLED_KEY = 'll.sync.enabled';

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

function read(key: string): string | undefined {
	if (!hasStorage()) return undefined;
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		// Private-mode / disabled-storage browsers throw on access.
		return undefined;
	}
}

function write(key: string, value: string): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore: storage unavailable or full */
	}
}

function remove(key: string): void {
	if (!hasStorage()) return;
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/**
 * Whether this build can sync at all.
 *
 * False when no `VITE_SYNC_URL` was baked in, which is the default. The
 * settings UI reads this to explain the absence rather than offering a switch
 * that could not do anything.
 */
export function isSyncAvailable(): boolean {
	return SYNC_URL !== undefined;
}

/** The stored pairing phrase, or `undefined` if there is none (or it is junk). */
export function getSyncPhrase(): string | undefined {
	const stored = read(PHRASE_KEY)?.trim();
	if (!stored) return undefined;
	const phrase = normalizePhrase(stored);
	return isValidPhrase(phrase) ? phrase : undefined;
}

/**
 * Mints a phrase for this device if it has none, and returns it.
 *
 * Returns `undefined` when the phrase cannot be persisted. That is not
 * defensive noise: an unpersisted phrase would be re-minted on the next boot,
 * so the device would join a different empty room every time it started. A
 * browser that cannot keep the phrase cannot sync, and saying so is the honest
 * answer — the app still works, locally, exactly as it did.
 */
export function ensureSyncPhrase(): string | undefined {
	const existing = getSyncPhrase();
	if (existing) return existing;

	const minted = mintPhrase();
	write(PHRASE_KEY, minted);
	return getSyncPhrase() === minted ? minted : undefined;
}

/**
 * Adopts a phrase from another device, pairing this one to that library.
 *
 * Accepts whatever the learner typed — {@link normalizePhrase} does the work —
 * and reports whether it looked like a phrase at all. Returns the canonical
 * form on success so the caller can show it back in the form it will be stored.
 */
export function setSyncPhrase(raw: string): string | undefined {
	const phrase = normalizePhrase(raw);
	if (!isValidPhrase(phrase)) return undefined;
	write(PHRASE_KEY, phrase);
	return getSyncPhrase() === phrase ? phrase : undefined;
}

/** Forgets the phrase and turns sync off. The local library is untouched. */
export function clearSyncPhrase(): void {
	remove(PHRASE_KEY);
	remove(ENABLED_KEY);
}

/**
 * Whether this device should connect on the next boot.
 *
 * All three conditions are part of the answer, so callers cannot get a `true`
 * they can't act on: the build has a backend, the learner turned it on, and a
 * phrase survived being stored.
 */
export function isSyncEnabled(): boolean {
	return isSyncAvailable() && read(ENABLED_KEY) === '1' && getSyncPhrase() !== undefined;
}

/** Turns sync on or off for the next boot. Enabling mints a phrase if needed. */
export function setSyncEnabled(enabled: boolean): void {
	if (!enabled) {
		remove(ENABLED_KEY);
		return;
	}
	if (ensureSyncPhrase() === undefined) return;
	write(ENABLED_KEY, '1');
}
