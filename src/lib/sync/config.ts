/**
 * Sync configuration and device identity — `localStorage`, never IndexedDB.
 *
 * Same policy and the same guarded accessors as `$lib/db/settings`: the sync
 * key is a secret (docs/sync.md §7), the server URL and the device id are
 * device-local facts, and none of the three may ever reach IndexedDB — which is
 * what keeps them out of the JSON export, whose envelope only ever names
 * profile/items/stats.
 *
 * Every read is wrapped: private-mode and storage-disabled browsers throw on
 * access, and sync must degrade silently rather than take the app down with it.
 */

const SERVER_STORAGE_KEY = 'll.syncServer';
const KEY_STORAGE_KEY = 'll.syncKey';
const DEVICE_STORAGE_KEY = 'll.syncDevice';

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

/** The sync server's base URL (no trailing slash), or `undefined` if unset. */
export function getSyncServer(): string | undefined {
	const url = read(SERVER_STORAGE_KEY)?.trim().replace(/\/+$/, '');
	return url ? url : undefined;
}

/** Stores the sync server URL. A blank value clears it. */
export function setSyncServer(url: string): void {
	const trimmed = url.trim().replace(/\/+$/, '');
	if (!trimmed) {
		remove(SERVER_STORAGE_KEY);
		return;
	}
	write(SERVER_STORAGE_KEY, trimmed);
}

/** The bearer key presented to the sync server, or `undefined` if unset. */
export function getSyncKey(): string | undefined {
	const key = read(KEY_STORAGE_KEY)?.trim();
	return key ? key : undefined;
}

/** Stores the sync key. A blank value clears it. */
export function setSyncKey(key: string): void {
	const trimmed = key.trim();
	if (!trimmed) {
		remove(KEY_STORAGE_KEY);
		return;
	}
	write(KEY_STORAGE_KEY, trimmed);
}

/** Forgets server URL and key. The device id survives, so re-enabling keeps identity. */
export function clearSyncConfig(): void {
	remove(SERVER_STORAGE_KEY);
	remove(KEY_STORAGE_KEY);
}

/**
 * In-process fallback id, used only when `localStorage` is unreachable.
 *
 * A device that cannot persist its id would otherwise mint a new one on every
 * call, and `device` is a merge input (it is part of a review entry's identity
 * and the tie-break in the sort order) — an unstable id would break dedupe.
 * Caching it at least keeps one browsing session self-consistent.
 */
let fallbackDeviceId: string | undefined;

/**
 * This device's stable id, minted on first use and persisted.
 *
 * Never cleared by {@link clearSyncConfig}: turning sync off and on again on
 * the same browser must not look like a new device, or its own already-pushed
 * events would stop being recognised as its own on the next pull.
 */
export function getDeviceId(): string {
	const stored = read(DEVICE_STORAGE_KEY)?.trim();
	if (stored) return stored;

	const minted = newUuid();
	write(DEVICE_STORAGE_KEY, minted);
	// The write is best-effort; if it silently failed, keep the id for this
	// process at least (see `fallbackDeviceId`).
	if (read(DEVICE_STORAGE_KEY)?.trim() !== minted) {
		fallbackDeviceId ??= minted;
		return fallbackDeviceId;
	}
	return minted;
}

/**
 * `crypto.randomUUID()`, with a plain-random fallback.
 *
 * The server rejects non-UUID event ids, so the fallback still has to produce
 * RFC 4122 shape; it only exists for insecure-origin browsers where
 * `crypto.randomUUID` is unavailable.
 */
export function newUuid(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const hex = (n: number) =>
		Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
	const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
	return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/**
 * True when this device is configured to sync — the gate on outbox capture
 * (§9: capture is opt-in and starts when sync is configured).
 */
export function syncEnabled(): boolean {
	return getSyncServer() !== undefined && getSyncKey() !== undefined;
}
