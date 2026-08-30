/**
 * Device identity and id minting.
 *
 * Both of these outlived the sync system they were written for. `getDeviceId`
 * is half of a review's identity — `reviews` is keyed `(itemId, at, device)`,
 * so two devices that logged a review in the same millisecond stay two reviews
 * — and `newUuid` mints the set-union keys for serves and results. Neither has
 * anything to do with syncing any more, so neither lives in a sync module.
 *
 * The device id is a device-local fact in `localStorage`, under the same `ll.*`
 * convention as `db/settings.ts` and `ui/prefs.ts`, and for the same reason:
 * it must never reach the events log, and so never the JSON export. Every access is
 * wrapped — private-mode and storage-disabled browsers throw on `localStorage`
 * — because failing here would take the app down over a preference.
 */

const DEVICE_STORAGE_KEY = 'll.syncDevice';

function read(key: string): string | undefined {
	if (typeof localStorage === 'undefined') return undefined;
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		// Private-mode / disabled-storage browsers throw on access.
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

/**
 * In-process fallback id, used only when `localStorage` is unreachable.
 *
 * A device that cannot persist its id would otherwise mint a new one on every
 * call, and the id is part of a review entry's identity — an unstable one would
 * write a fresh `reviews` row per review instead of deduping. Caching it at
 * least keeps one browsing session self-consistent.
 */
let fallbackDeviceId: string | undefined;

/**
 * This device's stable id, minted on first use and persisted.
 *
 * The storage key still reads `ll.syncDevice`. It is deliberately unchanged:
 * renaming it would mint a *new* id on every existing install, and since the id
 * is part of a review's key, every subsequent review would stop matching the
 * history already recorded under the old one. The name is a historical artifact;
 * the value is load-bearing.
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
 * The fallback keeps RFC 4122 shape and exists only for insecure-origin
 * browsers, where `crypto.randomUUID` is unavailable.
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
