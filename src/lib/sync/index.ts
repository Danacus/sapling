/**
 * Multi-device sync: the client half.
 *
 * The cycle, the probe, pairing and the phrase are `crates/sapling-sync`,
 * reached through `core.ts`; what stays here is the device's configuration
 * (`config.ts`, `url.ts`) and when to sync (`run.ts`). The server half is
 * `worker/`, a Cloudflare Worker that orders and relays the event log and
 * nothing else — every merge rule lives in `crates/sapling-db/src/materialize.rs`.
 */
export type { PairOutcome, SyncProbeResult } from '$lib/db/generated/index';
export {
	clearSyncPhrase,
	ensureSyncPhrase,
	getSyncPhrase,
	isSyncAvailable,
	isSyncEnabled,
	setSyncEnabled,
	setSyncPhrase
} from './config';
export {
	BAD_PHRASE,
	formatPhrase,
	isValidPhrase,
	mintPhrase,
	normalizePhrase,
	PHRASE_LENGTH
} from './core';
export {
	lastSyncOutcome,
	pairDevice,
	probeSync,
	runSync,
	type SyncOutcome,
	type SyncRecord
} from './run';
export { SYNC_URL } from './url';
