/**
 * Multi-device sync: the client half.
 *
 * The server half is `worker/`, a Cloudflare Worker that orders and relays the
 * event log and nothing else — every merge rule lives in
 * `src/lib/db/materialize.ts`.
 */
export {
	clearSyncPhrase,
	ensureSyncPhrase,
	getSyncPhrase,
	isSyncAvailable,
	isSyncEnabled,
	setSyncEnabled,
	setSyncPhrase
} from './config';
export { formatPhrase, isValidPhrase, mintPhrase, normalizePhrase, PHRASE_LENGTH } from './phrase';
export { probeSync, type SyncProbeResult } from './probe';
export { SYNC_URL } from './url';
