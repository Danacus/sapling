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
 * The second property, inherited straight from `sync/apply.ts`, is that the
 * result is a function of the event *set* and not of the order LiveStore
 * materialized it in. LiveStore rebases local events onto remote ones, which
 * rolls state back and replays it in a different order, so any rule that
 * depended on arrival order would produce a different answer after a sync than
 * before one. The two order-sensitive rules (both last-write-wins) therefore
 * compare against a recorded winner rather than simply overwriting, and the
 * two that must survive an out-of-order sibling (`item-deleted` beating a
 * later `item-added`, `review-amended` beating a later `item-reviewed`) record
 * a permanent marker.
 */
import { State } from '@livestore/livestore';

import { events } from './events';
import { beats, reviewKey, type EventKey } from './order';
import { PROFILE_ID, tables } from './tables';

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

/** The recorded LWW winner for a row, or `null` when nothing has claimed it. */
function winnerOf(row: {
	patchAt: number | null;
	patchDevice: string | null;
	patchEventId: string | null;
}): EventKey | null {
	return row.patchAt === null || row.patchDevice === null || row.patchEventId === null
		? null
		: { at: row.patchAt, device: row.patchDevice, id: row.patchEventId };
}

export const materializers = State.SQLite.materializers(events, {
	/**
	 * Creates, or is a no-op if the id exists — and a no-op if the id was ever
	 * deleted. §4 gives the tombstone priority over anything concurrent, and a
	 * permanent tombstone is what extends that to anything *later*, which is
	 * what an out-of-order sync (or a rebase) can produce.
	 */
	'v1.ItemAdded': (payload, { query }) => {
		if (query(tables.tombstones.where({ itemId: payload.id }).first())) return [];
		return tables.items
			.insert({
				id: payload.id,
				kind: payload.kind,
				term: payload.term,
				meaning: payload.meaning,
				romanization: payload.romanization ?? null,
				notes: payload.notes ?? null,
				introducedAt: payload.introducedAt,
				patchAt: null,
				patchDevice: null,
				patchEventId: null
			})
			.onConflict('id', 'ignore');
	},

	/**
	 * Inserts one history entry, keyed by `(itemId, at, device)`.
	 *
	 * Two deviations from `sync/apply.ts`, both in the direction §1 asks for
	 * ("no lost reviews"):
	 *
	 * - A review for an item this device has not seen yet is **kept**, where
	 *   the old engine dropped it. It is inert until the `item-added` lands and
	 *   then counts, instead of being lost to arrival order.
	 * - Nothing needs a "counted event ids" ledger: the row *is* the dedupe.
	 */
	'v1.ItemReviewed': ({ eventId, device, at, itemId, grade }, { query }) => {
		const key = reviewKey(itemId, at, device);
		if (query(tables.supersededReviews.where({ key }).first())) return [];
		if (query(tables.tombstones.where({ itemId }).first())) return [];
		return tables.reviews
			.insert({ id: key, itemId, at, grade, device, eventId })
			.onConflict('id', 'ignore');
	},

	/**
	 * Replaces the entry it supersedes, in either arrival order.
	 *
	 * The supersession is recorded *before* the delete so that the original
	 * `item-reviewed`, if it has not been materialized yet, is refused when it
	 * arrives. The new entry uses `'replace'` rather than `'ignore'` because an
	 * amend is precisely the case where an existing entry's grade must change.
	 */
	'v1.ReviewAmended': ({ eventId, device, at, itemId, grade, replaces }, { query }) => {
		if (query(tables.tombstones.where({ itemId }).first())) return [];

		const ops = [];
		if (replaces !== undefined) {
			const superseded = reviewKey(itemId, replaces, device);
			ops.push(tables.supersededReviews.insert({ key: superseded }).onConflict('key', 'ignore'));
			ops.push(tables.reviews.delete().where({ id: superseded }));
		}
		ops.push(
			tables.reviews
				.insert({ id: reviewKey(itemId, at, device), itemId, at, grade, device, eventId })
				.onConflict('id', 'replace')
		);
		return ops;
	},

	/**
	 * Last-write-wins per field, decided against the incumbent's own
	 * `(at, device, id)` rather than against materialization order — which is
	 * what makes an older patch replayed after a newer one a no-op instead of a
	 * regression.
	 */
	'v1.ItemUpdated': ({ eventId, device, at, itemId, fields }, { query }) => {
		const item = query(tables.items.where({ id: itemId }).first());
		if (!item) return [];
		if (!beats({ at, device, id: eventId }, winnerOf(item))) return [];
		return tables.items
			.update({
				...definedOnly(fields),
				patchAt: at,
				patchDevice: device,
				patchEventId: eventId
			})
			.where({ id: itemId });
	},

	/** The tombstone is permanent; the item and its history go with it. */
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
	 *
	 * A serve for a challenge this device has not pooled yet is kept rather
	 * than dropped, for the same reason as an early review.
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

	/** Whole-object LWW, same comparison as `item-updated`. */
	'v1.ProfileUpdated': (payload, { query }) => {
		const { eventId, device, at, ...profile } = payload;
		const row = {
			nativeLanguage: profile.nativeLanguage,
			targetLanguage: profile.targetLanguage,
			level: profile.level,
			interests: profile.interests,
			about: profile.about ?? null,
			model: profile.model,
			createdAt: profile.createdAt,
			patchAt: at,
			patchDevice: device,
			patchEventId: eventId
		};

		const current = query(tables.profile.where({ id: PROFILE_ID }).first());
		if (!current) {
			return tables.profile.insert({ id: PROFILE_ID, ...row }).onConflict('id', 'ignore');
		}
		if (!beats({ at, device, id: eventId }, winnerOf(current))) return [];
		return tables.profile.update(row).where({ id: PROFILE_ID });
	}
});
