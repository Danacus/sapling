/**
 * What the client hands the sync Worker when it opens a connection.
 *
 * This travels in the WebSocket URL's query string, which is why it carries the
 * phrase and nothing else: it is the credential, and every extra field would be
 * one more thing written into somebody's request log for no benefit. The sync
 * URL is *not* in here for that reason — the leader worker already knows it
 * from `url.ts`, so putting it in the payload would only mail the Worker its
 * own address.
 *
 * The payload's absence is meaningful. `undefined` is how the client says sync
 * is turned off on this device, and `livestore.worker.ts` reads it exactly that
 * way — see `offline-backend.ts`.
 */
import { Schema } from '@livestore/livestore';

/** The credential a client presents to open a sync connection. */
export const SyncPayload = Schema.Struct({
	/** The learner's pairing phrase, canonical (see `phrase.ts`). */
	phrase: Schema.String
});

export type SyncPayload = typeof SyncPayload.Type;
