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
 *   just rows.  `timesServed` and `lastServedAt` are `COUNT` and `MAX`.
 *
 * What is *not* here any more: the `patchAt`/`patchDevice`/`patchEventId`
 * columns and the `supersededReviews` table. Both existed to reconstruct a
 * merge order the eventlog now supplies directly — see the note on ordering in
 * `materializers.ts`.
 *
 * `tombstones` **is** here, having been removed in step 3 and reinstated in
 * step 4b. That reversal is explained where the argument for removing it lived,
 * in `materializers.ts`; the short version is that it was never about ordering,
 * so retiring §4's order was never a reason to drop it.
 */
import { Schema, State } from '@livestore/livestore';

/** The `profile` table holds exactly one row under this key, as Dexie's does. */
export const PROFILE_ID = 'singleton';

/** The single row of {@link tables.migrationState}. */
export const MIGRATION_STATE_ID = 'local';

/**
 * Identity of one history entry: `(itemId, at, device)` (§4).
 *
 * This is the `reviews` primary key rather than the originating event id, and
 * it survives the move to log order untouched, because it was never an
 * *ordering* — it is what makes two devices that recorded the same review
 * collapse to one entry even though their events differ.
 */
export function reviewKey(itemId: string, at: number, device: string): string {
	return `${itemId}|${at}|${device}`;
}

export const tables = {
	/** `KnowledgeItem` content. No card and no history — both are derived. */
	items: State.SQLite.table({
		name: 'items',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			kind: State.SQLite.text(),
			term: State.SQLite.text(),
			meaning: State.SQLite.text(),
			romanization: State.SQLite.text({ nullable: true }),
			notes: State.SQLite.text({ nullable: true }),
			introducedAt: State.SQLite.integer()
		}
	}),

	/** One row per review, keyed by {@link reviewKey}. */
	reviews: State.SQLite.table({
		name: 'reviews',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			itemId: State.SQLite.text(),
			at: State.SQLite.integer(),
			grade: State.SQLite.integer(),
			device: State.SQLite.text()
		}
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
	 * Ids that have been deleted, and must stay deleted.
	 *
	 * A delete has to outrank an `item-added` that reaches this client *later*,
	 * and step 3 was wrong to conclude that could not happen — see the note in
	 * `materializers.ts`. The row is the whole mechanism: `v1.ItemAdded` checks
	 * for it, and it is never removed, because an id is a UUID that is never
	 * re-minted and a resurrected word is indistinguishable from a new one.
	 *
	 * Grow-only, and tiny: one short row per word the learner ever deleted.
	 */
	tombstones: State.SQLite.table({
		name: 'tombstones',
		columns: {
			itemId: State.SQLite.text({ primaryKey: true })
		}
	}),

	/**
	 * Whether this browser's legacy Dexie database has been carried across.
	 *
	 * A `clientDocument`, which is **client-only** — its derived `set` event
	 * carries `clientOnly: true`, so it is never synced (verified in
	 * `@livestore/common/src/schema/state/sqlite/client-document-def.ts`). That
	 * matters: a synced marker would reach the learner's *other* device, which
	 * has its own un-migrated Dexie database, and that device would skip its own
	 * migration and lose everything it learned before the upgrade.
	 *
	 * It lives here rather than in `localStorage` because **a marker belongs in
	 * the same storage as the data it describes.** `localStorage` and OPFS are
	 * separate buckets that can be cleared independently, and that divergence was
	 * the bug: clearing `localStorage` alone re-ran the migration against a store
	 * that already held its output. Kept in OPFS the marker is self-correcting —
	 * if OPFS is cleared the migrated data is gone too, so re-migrating is then
	 * the *correct* behaviour rather than a duplicate.
	 *
	 * `0` means "not yet"; the default makes an absent row read that way without
	 * a special case.
	 */
	migrationState: State.SQLite.clientDocument({
		name: 'MigrationState',
		schema: Schema.Struct({ dexieMigratedAt: Schema.Number }),
		default: { id: MIGRATION_STATE_ID, value: { dexieMigratedAt: 0 } }
	}),

	/** The singleton profile. Overwritten wholesale by the latest event in the log. */
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
			createdAt: State.SQLite.integer()
		}
	})
};
