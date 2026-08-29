/**
 * The write model: `docs/sync.md` §3's ten event types.
 *
 * These mirror `SYNC_PAYLOAD_SCHEMAS` in `sync/events.ts` — the same ten
 * names, the same payload fields — with one addition. Today's payloads travel
 * inside an envelope carrying `id`, `device` and `at`, and §4's merge rules
 * read all three. LiveStore has an envelope of its own, but it is a *different*
 * envelope: its event id and sequence are assigned per client session, so
 * ordering by them is deterministic yet not the order §4 specifies. The three
 * fields the merge actually reads are therefore carried **in the payload**, on
 * the events whose rules need them, and nowhere else:
 *
 * - `eventId` — set-union key for serves and results, tie-break for LWW.
 * - `device` — part of a history entry's identity, and an LWW tie-break.
 * - `at` — the domain's own notion of when, and the primary LWW key.
 *
 * `item-added`, `item-deleted` and `challenge-reported` carry none of them:
 * their rules dedupe on the id of the thing itself, so envelope data would be
 * dead weight.
 *
 * The retired `xp-banked` (§3) is deliberately absent. LiveStore 0.4's
 * `unknownEventHandling` covers it at the schema level — see `schema.ts`.
 */
import { Events, Schema } from '@livestore/livestore';

/** Fields shared by every rule that resolves ties by `(at, device, id)`. */
const ordering = {
	eventId: Schema.String,
	device: Schema.String,
	at: Schema.Number
};

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
			...ordering,
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
			...ordering,
			itemId: Schema.String,
			grade: Schema.Number,
			replaces: Schema.optional(Schema.Number)
		})
	}),

	/**
	 * Last-write-wins field patch.
	 *
	 * Deliberately cannot carry `id`, `kind` or `introducedAt`: identity and
	 * birth date are immutable, and a patch able to rewrite them would make LWW
	 * dangerous rather than merely lossy.
	 */
	itemUpdated: Events.synced({
		name: 'v1.ItemUpdated',
		schema: Schema.Struct({
			...ordering,
			itemId: Schema.String,
			fields: Schema.Struct({
				term: Schema.optional(Schema.String),
				meaning: Schema.optional(Schema.String),
				romanization: Schema.optional(Schema.String),
				notes: Schema.optional(Schema.String)
			})
		})
	}),

	/** Tombstone. Wins over anything concurrent, and over anything later. */
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

	/** The whole profile, last-write-wins by `(at, device, id)`. */
	profileUpdated: Events.synced({
		name: 'v1.ProfileUpdated',
		schema: Schema.Struct({
			...ordering,
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
