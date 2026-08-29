/**
 * The read model: `docs/sync.md` §4's merged state, as SQLite tables.
 *
 * Three shapes here differ from the Dexie schema they replace, and each
 * difference deletes merge code rather than adding a column:
 *
 * - **`reviews` is a table, not a JSON array on the item.** §4's "insert into
 *   `history` keyed by `(at, device)`" becomes a primary key, and "order
 *   deterministically, replay" becomes `ORDER BY`.
 * - **No `fsrsCard` column.** §4 already recomputes the card by replaying the
 *   merged history, so it is derived (`derive.ts`), never stored. Nothing can
 *   drift between a stored card and a stored history because there is no
 *   stored card.
 * - **`serves` and `results` are tables keyed by event id.** §4 counts
 *   *distinct applied* serve events and set-unions results by event id; both
 *   were bookkeeping sets in `sync/apply.ts` (`countedEventIds`) and are now
 *   just rows. `timesServed` and `lastServedAt` are `COUNT` and `MAX`.
 *
 * The two tables that exist purely to make out-of-order delivery safe —
 * `tombstones` and `supersededReviews` — are the bookkeeping §4 could not
 * avoid either. They are the price of a rule that has to hold whichever event
 * lands first.
 */
import { Schema, State } from '@livestore/livestore';

/** The `profile` table holds exactly one row under this key, as Dexie's does. */
export const PROFILE_ID = 'singleton';

export const tables = {
	/**
	 * `KnowledgeItem` content. No card and no history — both are derived.
	 *
	 * `patchAt` / `patchDevice` / `patchEventId` record which `item-updated`
	 * currently owns the mutable fields, so a patch arriving out of order can
	 * be compared against the incumbent instead of blindly overwriting it.
	 * Null until the first patch lands.
	 */
	items: State.SQLite.table({
		name: 'items',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			kind: State.SQLite.text(),
			term: State.SQLite.text(),
			meaning: State.SQLite.text(),
			romanization: State.SQLite.text({ nullable: true }),
			notes: State.SQLite.text({ nullable: true }),
			introducedAt: State.SQLite.integer(),
			patchAt: State.SQLite.integer({ nullable: true }),
			patchDevice: State.SQLite.text({ nullable: true }),
			patchEventId: State.SQLite.text({ nullable: true })
		}
	}),

	/**
	 * One row per review. `id` is `reviewKey(itemId, at, device)` — §4's history
	 * identity — so two devices recording the same review converge to one row.
	 * `eventId` is kept for provenance only; nothing merges on it.
	 */
	reviews: State.SQLite.table({
		name: 'reviews',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			itemId: State.SQLite.text(),
			at: State.SQLite.integer(),
			grade: State.SQLite.integer(),
			device: State.SQLite.text(),
			eventId: State.SQLite.text()
		}
	}),

	/**
	 * History entries a `review-amended` has replaced, by `reviewKey`.
	 *
	 * §4's out-of-order half: the amend may be materialized before the review
	 * it supersedes, so the supersession is recorded permanently and
	 * `item-reviewed` consults it before inserting.
	 */
	supersededReviews: State.SQLite.table({
		name: 'supersededReviews',
		columns: { key: State.SQLite.text({ primaryKey: true }) }
	}),

	/**
	 * Deleted item ids. Permanent, because §4 gives a tombstone priority over
	 * anything concurrent — including an `item-added` that arrives afterwards.
	 */
	tombstones: State.SQLite.table({
		name: 'tombstones',
		columns: { itemId: State.SQLite.text({ primaryKey: true }) }
	}),

	/**
	 * The challenge pool. `content` is the immutable `Challenge` union stored
	 * whole as JSON: §4 identifies challenges by id and copies content through
	 * verbatim, so normalising a six-member union into columns would buy the
	 * merge nothing and cost a migration every time a challenge type is added.
	 *
	 * `timesServed` and `lastServedAt` are deliberately absent — they are
	 * `COUNT`/`MAX` over `serves`.
	 */
	challenges: State.SQLite.table({
		name: 'challenges',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			content: State.SQLite.json(),
			generatedAt: State.SQLite.integer(),
			topic: State.SQLite.text({ nullable: true }),
			reported: State.SQLite.boolean({ default: false })
		}
	}),

	/** One row per serve, keyed by the originating event id (§4: distinct events). */
	serves: State.SQLite.table({
		name: 'serves',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			challengeId: State.SQLite.text(),
			at: State.SQLite.integer()
		}
	}),

	/** The answer log — a set-union by event id, so the event id is the key. */
	results: State.SQLite.table({
		name: 'results',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			challengeId: State.SQLite.text(),
			verdict: State.SQLite.text(),
			answerGiven: State.SQLite.text(),
			at: State.SQLite.integer()
		}
	}),

	/**
	 * The singleton profile, whole-object last-write-wins by `(at, device, id)`.
	 * The same three `patch*` columns carry the incumbent's key.
	 */
	profile: State.SQLite.table({
		name: 'profile',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			nativeLanguage: State.SQLite.text(),
			targetLanguage: State.SQLite.text(),
			level: State.SQLite.text(),
			interests: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
			about: State.SQLite.text({ nullable: true }),
			model: State.SQLite.text(),
			createdAt: State.SQLite.integer(),
			patchAt: State.SQLite.integer(),
			patchDevice: State.SQLite.text(),
			patchEventId: State.SQLite.text()
		}
	})
};
