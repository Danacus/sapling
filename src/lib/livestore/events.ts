/**
 * The write model: `docs/sync.md` §3's ten event types.
 *
 * These mirror `SYNC_PAYLOAD_SCHEMAS` in `sync/events.ts` — the same ten
 * names, the same payload fields — minus the envelope data §4 used to need.
 *
 * The old design carried `(eventId, device, at)` on every order-sensitive
 * event so the merge could reconstruct §4's total order. **It no longer does.**
 * The eventlog *is* the order now (see §4 in `docs/sync.md`), so a rule that
 * used to compare timestamps just applies in the order it is handed. What
 * remains is carried only where it means something to the domain:
 *
 * - `at` — when the learner did the thing. Reviews need it (FSRS folds on it),
 *   serves and results record it. It is no longer a merge input.
 * - `device` — half of a history entry's identity, so two devices that logged
 *   the same review in the same millisecond stay two reviews.
 * - `eventId` — the set-union key for serves and results, which must dedupe
 *   across a replay. Reviews do *not* carry one: their identity is
 *   `(itemId, at, device)`, LiveStore's own envelope already provides
 *   provenance, and a stored copy would only make two clients' rows differ in
 *   a field neither of them reads.
 *
 * `item-updated` and `profile-updated` carry none of the three: they are plain
 * overwrites, and the log decides which one is last.
 *
 * The retired `xp-banked` (§3) is deliberately absent. LiveStore 0.4's
 * `unknownEventHandling` covers it at the schema level — see `schema.ts`.
 */
import { Events, Schema } from '@livestore/livestore';

export const events = {
	/** Item content only — no card, no history (§3). */
	itemAdded: Events.synced({
		name: 'v1.ItemAdded',
		schema: Schema.Struct({
			id: Schema.String,
			kind: Schema.Literal('vocab', 'grammar'),
			term: Schema.String,
			meaning: Schema.String,
			romanization: Schema.optional(Schema.String),
			notes: Schema.optional(Schema.String),
			introducedAt: Schema.Number
		})
	}),

	/** Exactly one history entry. Identity is `(itemId, at, device)`. */
	itemReviewed: Events.synced({
		name: 'v1.ItemReviewed',
		schema: Schema.Struct({
			device: Schema.String,
			at: Schema.Number,
			itemId: Schema.String,
			grade: Schema.Number
		})
	}),

	/**
	 * A re-grade of a review the emitting device already logged.
	 *
	 * `at`/`grade` describe the entry as it now stands; `replaces` names the
	 * `at` of the entry it displaced, and is absent when there was nothing to
	 * replace. The two timestamps genuinely differ — see `amendPayloadSchema`
	 * in `sync/events.ts` for why the spec's original assumption was wrong.
	 */
	reviewAmended: Events.synced({
		name: 'v1.ReviewAmended',
		schema: Schema.Struct({
			device: Schema.String,
			at: Schema.Number,
			itemId: Schema.String,
			grade: Schema.Number,
			replaces: Schema.optional(Schema.Number)
		})
	}),

	/**
	 * Field patch, applied in log order.
	 *
	 * Deliberately cannot carry `id`, `kind` or `introducedAt`: identity and
	 * birth date are immutable, and a patch able to rewrite them would make a
	 * blind overwrite dangerous rather than merely lossy.
	 */
	itemUpdated: Events.synced({
		name: 'v1.ItemUpdated',
		schema: Schema.Struct({
			itemId: Schema.String,
			fields: Schema.Struct({
				term: Schema.optional(Schema.String),
				meaning: Schema.optional(Schema.String),
				romanization: Schema.optional(Schema.String),
				notes: Schema.optional(Schema.String)
			})
		})
	}),

	/** Tombstone. The item and its history go. */
	itemDeleted: Events.synced({
		name: 'v1.ItemDeleted',
		schema: Schema.Struct({ itemId: Schema.String })
	}),

	/**
	 * Immutable challenge content plus its pool metadata.
	 *
	 * `challenge` is `Schema.Any` on purpose. An Effect `Schema.Struct` strips
	 * unknown keys on decode, which would quietly amputate the body of every
	 * challenge — the exact opposite of the `z.looseObject` it replaces. The
	 * merge never reads below `type` anyway (§4), and the producer already
	 * validated the content against `challengeSchema` at generation time. The
	 * `type` allow-list that `challengeContentSchema` enforced is reinstated in
	 * the materializer, where it can drop a row without discarding the event.
	 */
	challengeAdded: Events.synced({
		name: 'v1.ChallengeAdded',
		schema: Schema.Struct({
			challenge: Schema.Any,
			generatedAt: Schema.Number,
			topic: Schema.optional(Schema.String)
		})
	}),

	/** One serve. `timesServed` is the count of distinct such events (§4). */
	challengeServed: Events.synced({
		name: 'v1.ChallengeServed',
		schema: Schema.Struct({
			eventId: Schema.String,
			challengeId: Schema.String,
			at: Schema.Number
		})
	}),

	/** Permanent exclusion. A sticky boolean, so it needs no ordering data. */
	challengeReported: Events.synced({
		name: 'v1.ChallengeReported',
		schema: Schema.Struct({ challengeId: Schema.String })
	}),

	/**
	 * One answered challenge. Set-union by event id, because two answers can be
	 * genuinely identical — same challenge, same typo, same millisecond.
	 */
	resultLogged: Events.synced({
		name: 'v1.ResultLogged',
		schema: Schema.Struct({
			eventId: Schema.String,
			challengeId: Schema.String,
			verdict: Schema.Literal('correct', 'almost', 'wrong'),
			answerGiven: Schema.String,
			at: Schema.Number
		})
	}),

	/** The whole profile, overwritten in log order. */
	profileUpdated: Events.synced({
		name: 'v1.ProfileUpdated',
		schema: Schema.Struct({
			nativeLanguage: Schema.String,
			targetLanguage: Schema.String,
			level: Schema.Literal('beginner', 'elementary', 'intermediate', 'advanced'),
			interests: Schema.Array(Schema.String),
			about: Schema.optional(Schema.String),
			model: Schema.String,
			createdAt: Schema.Number
		})
	})
};
