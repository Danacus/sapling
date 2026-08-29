/**
 * `docs/sync.md` §4's merge rules, as materializers.
 *
 * Every one of them is **total**: it returns mutations or it returns `[]`, and
 * it never throws. That is not a style preference. A materializer that throws
 * does not skip its event — it shuts the store down permanently, and every
 * subsequent read fails with "Store has been shut down" (the step-1 spike
 * found this the hard way, via a bare `insert` onto a duplicate primary key).
 * `.onConflict(...)` and an early `[]` are what keep them total.
 *
 * ## Order is the eventlog's job now
 *
 * §4 used to specify a total order of its own — sort by `(at, device, id)`,
 * then replay — and `sync/apply.ts` carried the bookkeeping to reconstruct it.
 * That is gone. LiveStore already gives every client the same totally ordered
 * eventlog, and rebasing places a client's own events after the remote ones it
 * had not seen, so materializing in log order is deterministic across clients
 * by construction. Two devices holding the same log hold the same state.
 *
 * The change is not merely mechanical: it is a **behaviour change, chosen
 * deliberately**. §4's order trusted a wall clock, so a device whose clock ran
 * fast could stamp `at` into the future and win every last-write-wins contest
 * indefinitely — including against edits made later in real time. Log order
 * tracks the order things actually reached the log, which is a better proxy
 * for causality than a clock nobody can audit. The cost is that "last write"
 * now means last to arrive rather than latest timestamp; for a single learner
 * on a handful of devices that is the more predictable of the two.
 *
 * Two pieces of machinery fell out with it, and it is worth recording *why*
 * each is unnecessary rather than merely unused:
 *
 * - **The `patch*` columns**, which recorded the incumbent's `(at, device, id)`
 *   so a patch could be compared against it. With a single order there is no
 *   contest to arbitrate: the later event in the log wins by being applied
 *   second.
 * - **`supersededReviews`**, which let a `review-amended` land before the
 *   `item-reviewed` it replaces. An amend re-grades a review *this device wrote
 *   moments earlier*, so the two are always adjacent in one client's own order.
 *
 * ## `tombstones` came back (step 4b), and the step-3 argument for dropping it
 *
 * Step 3 removed `tombstones` too, reasoning: *"an `item-added` cannot arrive
 * after a delete. A delete is only ever emitted by a device that already holds
 * the item, so the add precedes it in that device's own event order, and rebase
 * preserves a client's internal order."*
 *
 * Every clause of that is true and the conclusion is still wrong, because it
 * quietly assumes the two events come from the same causal line. **A second
 * device's Dexie migration breaks the assumption.** Both devices were synced
 * under the old system, so both hold word *W*; both back-date their own
 * `item-added` for it. If the phone migrates, the learner deletes *W*, and the
 * laptop is opened a week later, the laptop's migration emits an `item-added`
 * for *W* that is causally unrelated to the phone's delete and simply lands
 * after it. Under log order that add wins, and the deleted word returns.
 *
 * So a tombstone was never really about *ordering* — it is about an add and a
 * delete that never shared a history. Retiring §4's order was therefore never a
 * reason to drop it, and reinstating it is **not** a partial reversal of the
 * arrival-order decision: the ordering semantics above are untouched.
 *
 * What a post-delete review still leaves behind is an inert `reviews` row for
 * an item that no longer exists. Nothing reads it — every read joins from
 * `items`, and with a tombstone in place the item can never come back — so it
 * is unreachable rather than merely harmless. `v1.ItemReviewed` deliberately
 * does *not* pay for a tombstone lookup to avoid writing it: that would be a
 * query per review, and a migration replays thousands of them.
 */
import { State } from '@livestore/livestore';

import { events } from './events';
import { PROFILE_ID, reviewKey, tables } from './tables';

/**
 * The challenge types this build knows how to play.
 *
 * Mirrors the allow-list in `challengeContentSchema` (`sync/events.ts`) and
 * carries the same obligation: **every new member of the `Challenge` union has
 * to be added here too**, or challenges of that type are dropped on arrival
 * instead of pooled. Enforcing it here rather than in the event schema means an
 * unknown type costs one skipped row, not a rejected event — the eventlog keeps
 * it, and a later build that knows the type will materialize it on replay.
 */
const CHALLENGE_TYPES = new Set([
	'multiple-choice',
	'cloze',
	'typed-translation',
	'match-pairs',
	'word-order',
	'spot-error'
]);

/** Drops `undefined` values so an absent patch field never blanks a set one. */
function definedOnly<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

export const materializers = State.SQLite.materializers(events, {
	/**
	 * Creates, or is a no-op if the id exists — or if it was ever deleted.
	 *
	 * The tombstone check is what stops a second device's migration resurrecting
	 * a word deleted on the first (see the note above). It costs one indexed
	 * lookup on a primary key per added item, which is paid once per item rather
	 * than once per review.
	 */
	'v1.ItemAdded': (payload, { query }) => {
		const deleted = query(tables.tombstones.where({ itemId: payload.id }).first());
		if (deleted !== undefined) return [];
		return tables.items
			.insert({
				id: payload.id,
				kind: payload.kind,
				term: payload.term,
				meaning: payload.meaning,
				romanization: payload.romanization ?? null,
				notes: payload.notes ?? null,
				introducedAt: payload.introducedAt
			})
			.onConflict('id', 'ignore');
	},

	/**
	 * Inserts one history entry, keyed by `(itemId, at, device)`.
	 *
	 * A review for an item this client has not materialized yet is **kept**,
	 * where `sync/apply.ts` dropped it — §1's "no lost reviews", honoured a
	 * little more strictly. It is inert until the `item-added` lands and then
	 * counts. Nothing needs a "counted event ids" ledger either: the row *is*
	 * the dedupe.
	 */
	'v1.ItemReviewed': ({ device, at, itemId, grade }) =>
		tables.reviews
			.insert({ id: reviewKey(itemId, at, device), itemId, at, grade, device })
			.onConflict('id', 'ignore'),

	/**
	 * Replaces the entry it supersedes.
	 *
	 * `'replace'` rather than `'ignore'` because an amend is precisely the case
	 * where an existing entry's grade must change — a re-grade landing on the
	 * same millisecond as the review it replaces must still take effect.
	 */
	'v1.ReviewAmended': ({ device, at, itemId, grade, replaces }) => {
		const ops = [];
		if (replaces !== undefined) {
			ops.push(tables.reviews.delete().where({ id: reviewKey(itemId, replaces, device) }));
		}
		ops.push(
			tables.reviews
				.insert({ id: reviewKey(itemId, at, device), itemId, at, grade, device })
				.onConflict('id', 'replace')
		);
		return ops;
	},

	/** A patch of the mutable fields. An update against a missing row is a no-op. */
	'v1.ItemUpdated': ({ itemId, fields }) => {
		const patch = definedOnly(fields);
		if (Object.keys(patch).length === 0) return [];
		return tables.items.update(patch).where({ id: itemId });
	},

	/**
	 * The item and its history go together, and the id is remembered.
	 *
	 * The tombstone outlives both, because the whole point is to refuse an
	 * `item-added` that has not arrived yet.
	 */
	'v1.ItemDeleted': ({ itemId }) => [
		tables.tombstones.insert({ itemId }).onConflict('itemId', 'ignore'),
		tables.reviews.delete().where({ itemId }),
		tables.items.delete().where({ id: itemId })
	],

	/** Content is immutable, so the challenge id alone dedupes. */
	'v1.ChallengeAdded': ({ challenge, generatedAt, topic }) => {
		const content = challenge as { id?: unknown; type?: unknown };
		if (typeof content?.id !== 'string' || typeof content?.type !== 'string') return [];
		if (!CHALLENGE_TYPES.has(content.type)) return [];
		return tables.challenges
			.insert({
				id: content.id,
				content: challenge,
				generatedAt,
				topic: topic ?? null,
				reported: false
			})
			.onConflict('id', 'ignore');
	},

	/**
	 * One row per serve. `timesServed` and `lastServedAt` are `COUNT` and `MAX`
	 * over this table (`derive.ts`), which is why nothing here increments a
	 * counter — an incremented counter would double under a rebase replay,
	 * whereas an idempotent insert cannot.
	 */
	'v1.ChallengeServed': ({ eventId, challengeId, at }) =>
		tables.serves.insert({ id: eventId, challengeId, at }).onConflict('id', 'ignore'),

	/** Sticky boolean. An update against a missing row is a no-op, not an error. */
	'v1.ChallengeReported': ({ challengeId }) =>
		tables.challenges.update({ reported: true }).where({ id: challengeId }),

	/** Set-union by event id. */
	'v1.ResultLogged': ({ eventId, challengeId, verdict, answerGiven, at }) =>
		tables.results
			.insert({ id: eventId, challengeId, verdict, answerGiven, at })
			.onConflict('id', 'ignore'),

	/** The whole profile, overwritten by whichever event is last in the log. */
	'v1.ProfileUpdated': (payload) =>
		tables.profile
			.insert({
				id: PROFILE_ID,
				nativeLanguage: payload.nativeLanguage,
				targetLanguage: payload.targetLanguage,
				level: payload.level,
				interests: payload.interests,
				about: payload.about ?? null,
				model: payload.model,
				createdAt: payload.createdAt
			})
			.onConflict('id', 'replace')
});
