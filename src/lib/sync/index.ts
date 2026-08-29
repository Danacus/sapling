/**
 * Multi-device sync: the client half.
 *
 * The server half is `worker/`, a Cloudflare Worker built on
 * `@livestore/sync-cf`. It sequences an append-only log and relays it; it never
 * merges and never reads a payload, because the merge rules all live in
 * `src/lib/livestore/materializers.ts` and resolve by position in the log.
 * `docs/livestore-sync.md` is the architecture; `docs/sync.md` §4 is why each
 * merge rule is what it is.
 *
 * `offline-backend.ts` is deliberately not re-exported here: it is imported by
 * the LiveStore leader worker and nothing else, and keeping it out of the
 * barrel keeps `config.ts` — which touches `localStorage` — out of that
 * worker's bundle.
 */
export {
	clearSyncPhrase,
	ensureSyncPhrase,
	getSyncPhrase,
	isSyncAvailable,
	isSyncEnabled,
	setSyncEnabled,
	setSyncPhrase,
	syncPayload
} from './config';
export { formatPhrase, isValidPhrase, mintPhrase, normalizePhrase, PHRASE_LENGTH } from './phrase';
export { SyncPayload } from './payload';
export { SYNC_URL } from './url';
