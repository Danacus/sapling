/**
 * SPIKE — a LiveStore schema over the smallest *real* slice of Sapling.
 *
 * This is not the migration. It exists to answer the questions in step 1 of
 * the LiveStore plan: does the web adapter coexist with our static build,
 * service worker and un-isolated TTS, and does the node adapter run under the
 * existing node-environment vitest?
 *
 * The slice is deliberately the hard half of `docs/sync.md`: items and their
 * review history. Two things are worth noticing in how it comes out.
 *
 * 1. `reviews` is its own table rather than a JSON blob on the item. Today
 *    `apply.ts` hand-merges history entries keyed by `(at, device)` and then
 *    replays them; here an `item-reviewed` event is an ordinary INSERT and the
 *    dedupe is the primary key. The merge code has nowhere to live.
 * 2. The FSRS card is *not stored*. `docs/sync.md` §4 already says the card is
 *    recomputed by replaying an item's merged history, so the card is a fold
 *    over `reviews`, exactly as `reviewCard` already computes it. Nothing has
 *    to keep a stored card and a stored history agreeing with each other.
 */
import { Events, makeSchema, Schema, State } from '@livestore/livestore';

export const tables = {
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

	/**
	 * One row per review, append-only — the `(at, grade, device)` entries that
	 * `KnowledgeItem.history` holds as an array today.
	 *
	 * `id` is the originating event's id, which is what makes the insert
	 * idempotent: replaying a synced eventlog cannot double-count a review.
	 */
	reviews: State.SQLite.table({
		name: 'reviews',
		columns: {
			id: State.SQLite.text({ primaryKey: true }),
			itemId: State.SQLite.text(),
			at: State.SQLite.integer(),
			grade: State.SQLite.integer(),
			device: State.SQLite.text({ nullable: true })
		}
	})
};

export const events = {
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

	itemReviewed: Events.synced({
		name: 'v1.ItemReviewed',
		schema: Schema.Struct({
			id: Schema.String,
			itemId: Schema.String,
			at: Schema.Number,
			grade: Schema.Number,
			device: Schema.optional(Schema.String)
		})
	}),

	itemDeleted: Events.synced({
		name: 'v1.ItemDeleted',
		schema: Schema.Struct({ id: Schema.String })
	})
};

/**
 * Materializers must be **total**. A materializer that throws does not skip
 * the event — it shuts the whole store down (spike finding: a bare `insert`
 * of a duplicate primary key raises `UNIQUE constraint failed` and every
 * subsequent `query` fails with "Store has been shut down").
 *
 * `.onConflict('id', 'ignore')` is what makes them total here, and it happens
 * to be the exact wording of `docs/sync.md` §4 — "`item-added` creates (or is
 * a no-op if the id exists)".
 */
const materializers = State.SQLite.materializers(events, {
	'v1.ItemAdded': ({ id, kind, term, meaning, romanization, notes, introducedAt }) =>
		tables.items
			.insert({
				id,
				kind,
				term,
				meaning,
				romanization: romanization ?? null,
				notes: notes ?? null,
				introducedAt
			})
			.onConflict('id', 'ignore'),

	'v1.ItemReviewed': ({ id, itemId, at, grade, device }) =>
		tables.reviews
			.insert({ id, itemId, at, grade, device: device ?? null })
			.onConflict('id', 'ignore'),

	// A tombstone deletes the item and its reviews. `docs/sync.md` §4 gives
	// deletion priority over concurrent reviews, which falls out of replay
	// order rather than needing a rule of its own.
	'v1.ItemDeleted': ({ id }) => [
		tables.reviews.delete().where({ itemId: id }),
		tables.items.delete().where({ id })
	]
});

const state = State.SQLite.makeState({ tables, materializers });

export const schema = makeSchema({ events, state });
