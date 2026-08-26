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
 * The **payload** schemas at the bottom of this file are *client-side rules
 * that happen to live in a file the server can read*: the server never calls
 * them, never imports them, and stores `payload` opaquely — which is what keeps
 * it a few hundred lines, keeps every merge rule in one place, and leaves the
 * door open to encrypting `payload` end-to-end later without redesigning the
 * server (§10). They live here rather than in a sibling module purely so that
 * "what a valid event looks like" is one file.
 *
 * Because of the no-import rule they **mirror `$lib/types` structurally rather
 * than importing it**. That is a deliberate, small duplication: importing
 * `$lib/types` (or `$lib/llm/schemas`) would break the server build, not just
 * this file. The shapes here are also intentionally *thinner* than the domain
 * types — see {@link challengeContentSchema}.
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

/* -------------------------------------------------------------------------- */
/* Payloads (§3). Structural mirrors of `$lib/types` — see the module header.  */
/* -------------------------------------------------------------------------- */

const nonEmpty = z.string().min(1);
/** Epoch milliseconds. Positive so `0`/negative junk never orders ahead of real data. */
const epochMs = z.int().positive();

/** Mirrors `KnowledgeItem`'s *content* fields: no `fsrsCard`, no `history`. */
export const itemContentSchema = z.object({
	id: nonEmpty,
	kind: z.enum(['vocab', 'grammar']),
	term: nonEmpty,
	meaning: nonEmpty,
	romanization: z.string().optional(),
	notes: z.string().optional(),
	introducedAt: epochMs
});

/**
 * The subset of item content an `item-updated` patch may carry.
 *
 * Deliberately not `id`, `kind` or `introducedAt`: identity and birth date are
 * immutable, and a patch that could rewrite them would make LWW dangerous
 * rather than merely lossy.
 */
export const itemPatchSchema = z.object({
	term: nonEmpty.optional(),
	meaning: nonEmpty.optional(),
	romanization: z.string().optional(),
	notes: z.string().optional()
});

/**
 * A stored `Challenge`, shape-checked rather than fully validated.
 *
 * The authoritative structural schema for the `Challenge` union is
 * `challengeSchema` in `$lib/llm/schemas.ts`, and it cannot be imported here
 * (module header). Re-typing ~100 lines of union in a second place would be a
 * standing drift hazard for no merge benefit: challenge content is **immutable
 * and opaque to the merge** — §4 identifies challenges by id and copies content
 * through verbatim; nothing in the apply engine reads a field below `type`. So
 * this checks exactly what the merge and the UI's discriminant depend on and
 * lets the rest ride along (`looseObject`). The payload's own producer already
 * validated it against `challengeSchema` at generation time.
 *
 * The one field that must be kept in step is `type`: it is an allow-list, so a
 * challenge type this file has never heard of is dropped on the receiving
 * device rather than pooled. **Every new member of the `Challenge` union has to
 * be added here too**, or the type simply will not survive a sync.
 */
export const challengeContentSchema = z.looseObject({
	id: nonEmpty,
	type: z.enum([
		'multiple-choice',
		'cloze',
		'typed-translation',
		'match-pairs',
		'word-order',
		'spot-error'
	]),
	direction: z.enum(['toTarget', 'toNative']),
	itemIds: z.array(z.string())
});

/** Mirrors `Profile`. */
export const profileContentSchema = z.object({
	nativeLanguage: nonEmpty,
	targetLanguage: nonEmpty,
	level: z.enum(['beginner', 'elementary', 'intermediate', 'advanced']),
	interests: z.array(z.string()),
	about: z.string().optional(),
	model: z.string(),
	createdAt: epochMs
});

/** Mirrors `ChallengeResult`. */
export const resultContentSchema = z.object({
	challengeId: nonEmpty,
	verdict: z.enum(['correct', 'almost', 'wrong']),
	answerGiven: z.string(),
	at: epochMs
});

/** One `KnowledgeItem.history` entry, as it travels between devices. */
export const reviewPayloadSchema = z.object({
	itemId: nonEmpty,
	/** The entry's own timestamp — part of its `(itemId, at, device)` identity. */
	at: epochMs,
	/** ts-fsrs `Rating`: 1 Again, 2 Hard, 3 Good, 4 Easy. */
	grade: z.int().min(1).max(4)
});

/**
 * A re-grade of a review this device already logged (`amendResult`).
 *
 * `at`/`grade` describe the entry as it now stands; `replaces` is the `at` of
 * the entry it took the place of. **This is a documented deviation from
 * `docs/sync.md` §3**, which assumed the amended entry keeps the original
 * timestamp. It does not: `amendResult` in `$lib/session/engine` stamps the
 * re-grade with its own `now` and `updateItemAfterReview({replaceLast})` writes
 * that, so an event carrying only the original `at` would describe a history
 * the emitting device does not have. Carrying both keeps the log an exact
 * description of local state — which matters because the apply engine
 * *re-folds* the card from history timestamps, and a device whose entry `at`
 * differed would compute a different card. `replaces` is absent when the
 * history was empty and the "amend" was really an append.
 */
export const amendPayloadSchema = reviewPayloadSchema.extend({
	replaces: epochMs.optional()
});

/** Every payload schema, keyed by the event type it validates. */
export const SYNC_PAYLOAD_SCHEMAS = {
	[EVENT_TYPES.itemAdded]: itemContentSchema,
	[EVENT_TYPES.itemReviewed]: reviewPayloadSchema,
	[EVENT_TYPES.reviewAmended]: amendPayloadSchema,
	[EVENT_TYPES.itemUpdated]: z.object({ itemId: nonEmpty, fields: itemPatchSchema }),
	[EVENT_TYPES.itemDeleted]: z.object({ itemId: nonEmpty }),
	[EVENT_TYPES.challengeAdded]: z.object({
		challenge: challengeContentSchema,
		generatedAt: epochMs,
		topic: z.string().optional()
	}),
	[EVENT_TYPES.challengeServed]: z.object({ challengeId: nonEmpty }),
	[EVENT_TYPES.challengeReported]: z.object({ challengeId: nonEmpty }),
	[EVENT_TYPES.resultLogged]: resultContentSchema,
	[EVENT_TYPES.profileUpdated]: profileContentSchema
} as const satisfies Record<SyncEventType, z.ZodType>;

/** The validated payload type for each event type. */
export type SyncPayloads = {
	[T in SyncEventType]: z.infer<(typeof SYNC_PAYLOAD_SCHEMAS)[T]>;
};

/** An event narrowed to one known type, with its payload already parsed. */
export type TypedSyncEvent<T extends SyncEventType = SyncEventType> = {
	[K in T]: Omit<SyncEvent, 'type' | 'payload'> & { type: K; payload: SyncPayloads[K] };
}[T];

/**
 * Validates one event's payload against the schema for its type.
 *
 * Returns `undefined` for an unknown type or a payload that does not fit —
 * never throws. Sync degrades silently (the audio-layer rule, §1): a single
 * malformed or from-the-future event is dropped, and the rest of the batch
 * still applies.
 */
export function parseSyncPayload<T extends SyncEventType>(
	type: T,
	payload: unknown
): SyncPayloads[T] | undefined {
	const schema = SYNC_PAYLOAD_SCHEMAS[type] as z.ZodType | undefined;
	if (!schema) return undefined;
	const parsed = schema.safeParse(payload);
	return parsed.success ? (parsed.data as SyncPayloads[T]) : undefined;
}

/**
 * Envelope + payload in one step: turns an untrusted `SyncEvent` into a
 * {@link TypedSyncEvent}, or `undefined` if either half fails to validate.
 */
export function typeSyncEvent(event: SyncEvent): TypedSyncEvent | undefined {
	const type = event.type as SyncEventType;
	const payload = parseSyncPayload(type, event.payload);
	if (payload === undefined) return undefined;
	return { ...event, type, payload } as TypedSyncEvent;
}
