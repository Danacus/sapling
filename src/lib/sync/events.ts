/**
 * The sync wire format — the one schema shared *verbatim* between the browser
 * client and the `server/` sync service (see `docs/sync.md` §3, §6, §8).
 *
 * This module is deliberately **dependency-free apart from zod**: no `$lib`
 * alias, no SvelteKit, no DOM, no other project import. The server compiles it
 * straight from this path (`../../src/lib/sync/events.ts`), which only keeps
 * working while the file stays plain TypeScript that both tsconfigs can read.
 * Reaching for `$lib/types` here would break the server build, not just this
 * file — put anything app-shaped in a sibling module instead.
 *
 * Scope is the **envelope only**. Per-type payload schemas are client-side
 * (slice 2), because the server must never need to understand the data: that
 * is what keeps it a few hundred lines, keeps every merge rule in one place,
 * and leaves the door open to encrypting `payload` end-to-end later without
 * redesigning the server (§10).
 */

import { z } from 'zod';

/**
 * One event in a user's append-only log.
 *
 * `type` is validated as *any* non-empty string rather than an enum on
 * purpose: the server is a dumb relay, and a client newer than the server must
 * be able to push event types the server has never heard of. Clients narrow it
 * against {@link EVENT_TYPES} themselves.
 *
 * `payload` is required but unconstrained. It may legitimately be `null`, so
 * anything serializing it must write `JSON.stringify(payload ?? null)` —
 * `JSON.stringify(undefined)` returns `undefined`, not a string.
 */
export const syncEventSchema = z.object({
	/** Client-minted UUID. The server dedupes on `(user, id)`, so pushes are idempotent. */
	id: z.uuid(),
	/** Stable per-device id, minted once and kept in localStorage. */
	device: z.string().min(1),
	/** Client wall-clock, epoch ms. The primary ordering key (§5 covers skew). */
	at: z.int().positive(),
	/** Discriminant; see {@link EVENT_TYPES}. */
	type: z.string().min(1),
	/** Opaque to the server, zod-validated per type on the client. */
	payload: z.unknown()
});

export type SyncEvent = z.infer<typeof syncEventSchema>;

/**
 * An event as it comes back from a pull: the same envelope plus the server's
 * `seq`. `seq` is assigned by the server, ascends monotonically within a user's
 * log, and is the *only* pull cursor a client needs to store.
 */
export const storedSyncEventSchema = syncEventSchema.extend({
	seq: z.int().positive()
});

export type StoredSyncEvent = z.infer<typeof storedSyncEventSchema>;

/**
 * The event vocabulary of `docs/sync.md` §3, as constants rather than a zod
 * enum — the envelope schema stays permissive (see above) while client code
 * gets one place to spell these names.
 */
export const EVENT_TYPES = {
	/** Item content only: `id, kind, term, meaning, romanization?, notes?, introducedAt`. No card, no history. */
	itemAdded: 'item-added',
	/** `itemId, at, grade` — exactly one history entry. */
	itemReviewed: 'item-reviewed',
	/** `itemId, at, grade` — replaces the entry with the same `(itemId, at)`. */
	reviewAmended: 'review-amended',
	/** `itemId, fields` — last-write-wins field patch. */
	itemUpdated: 'item-updated',
	/** `itemId` — tombstone; wins over anything concurrent. */
	itemDeleted: 'item-deleted',
	/** The immutable `Challenge` content plus `generatedAt, topic?`. */
	challengeAdded: 'challenge-added',
	/** `challengeId` — one serve; `timesServed` is the count of distinct such events. */
	challengeServed: 'challenge-served',
	/** `challengeId` — permanent exclusion. */
	challengeReported: 'challenge-reported',
	/** A whole `ChallengeResult`; the results log is a set-union by event id. */
	resultLogged: 'result-logged',
	/** `day, amount` — one session's banked XP; per-day totals are a *sum* across devices. */
	xpBanked: 'xp-banked',
	/** The whole `Profile` — last-write-wins by `at`. */
	profileUpdated: 'profile-updated'
} as const;

/** Union of the known event-type strings. */
export type SyncEventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** Protocol limits, enforced by the server and respected by the client's batching. */
export const SYNC_LIMITS = {
	/** Max events per push, and the default/max page size for a pull (§6). */
	maxEventsPerRequest: 500,
	/** Max serialized `payload` bytes for a single event. */
	maxPayloadBytes: 64 * 1024
} as const;
