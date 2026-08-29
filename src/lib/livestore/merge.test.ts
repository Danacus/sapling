/**
 * `docs/sync.md` §4's merge rules, asserted against a real store.
 *
 * The property under test throughout is the one §2 promises: **two devices
 * that have applied the same set of events hold identical state, regardless of
 * arrival order.** So most tests here apply the same events twice, in two
 * orders, and compare — rather than asserting one outcome and hoping order
 * never varies. It does vary: LiveStore rebases local events onto remote ones,
 * replaying them in an order neither device chose.
 *
 * `converges` permutes only the *concurrent* half of a scenario, never the
 * causal prefix. Reordering a patch ahead of the `item-added` it patches would
 * be testing an order that cannot occur: a device can only patch an item it
 * has, and per-device log order survives the server's `seq` (§6). `apply.ts`
 * leans on exactly the same assumption — it returns early when the item is
 * missing — so weakening it here would be inventing a requirement the shipped
 * engine never met either.
 */
import { describe, expect, it } from 'vitest';

import { deriveCard, serveStats } from './derive';
import { events, schema, tables } from './schema';
import { makeTestStore } from './store.testing';

type Store = Awaited<ReturnType<typeof makeTestStore>>;
type Commit = (store: Store) => void;

/** Applies `commits` in order and returns a comparable state snapshot. */
async function apply(commits: Commit[]) {
	const store = await makeTestStore();
	for (const commit of commits) commit(store);
	return {
		items: store.query(tables.items.orderBy('id', 'asc')),
		reviews: store.query(tables.reviews.orderBy('id', 'asc')),
		challenges: store.query(tables.challenges.orderBy('id', 'asc')),
		serves: store.query(tables.serves.orderBy('id', 'asc')),
		results: store.query(tables.results.orderBy('id', 'asc')),
		profile: store.query(tables.profile)
	};
}

/**
 * Applies `setup` then `concurrent`, and again with `concurrent` reversed.
 * Both must land on identical state.
 */
async function converges(setup: Commit[], concurrent: Commit[]) {
	const forwards = await apply([...setup, ...concurrent]);
	const backwards = await apply([...setup, ...[...concurrent].reverse()]);
	expect(backwards).toEqual(forwards);
	return forwards;
}

const addItem =
	(id: string, introducedAt = 1000): Commit =>
	(store) =>
		store.commit(
			events.itemAdded({ id, kind: 'vocab', term: '书', meaning: 'book', introducedAt })
		);

const review =
	(eventId: string, itemId: string, at: number, grade: number, device: string): Commit =>
	(store) =>
		store.commit(events.itemReviewed({ eventId, itemId, at, grade, device }));

const patch =
	(eventId: string, at: number, device: string, notes: string): Commit =>
	(store) =>
		store.commit(events.itemUpdated({ eventId, itemId: 'i1', at, device, fields: { notes } }));

const addChallenge =
	(id: string, type = 'cloze'): Commit =>
	(store) =>
		store.commit(
			events.challengeAdded({
				challenge: { id, type, direction: 'toTarget', itemIds: ['i1'], prompt: 'kept verbatim' },
				generatedAt: 5000
			})
		);

describe('§4 items', () => {
	it('treats a re-delivered add as a no-op', async () => {
		const state = await converges([], [addItem('i1'), addItem('i1')]);
		expect(state.items).toHaveLength(1);
	});

	it('gives a tombstone priority over an add that arrives after it', async () => {
		// The out-of-order half of "a tombstone wins over anything concurrent":
		// without a permanent tombstone, delete-then-add resurrects the item.
		const state = await converges(
			[],
			[addItem('i1'), (store) => store.commit(events.itemDeleted({ itemId: 'i1' }))]
		);
		expect(state.items).toHaveLength(0);
	});

	it('keeps two devices reviewing the same word in the same millisecond apart', async () => {
		// Identity is `(itemId, at, device)`, so this is two reviews, not one.
		const state = await converges(
			[addItem('i1')],
			[review('e1', 'i1', 2000, 3, 'dev-a'), review('e2', 'i1', 2000, 1, 'dev-b')]
		);
		expect(state.reviews).toHaveLength(2);
	});

	it('derives the same card from concurrent reviews whichever order they land in', async () => {
		const setup = [addItem('i1', 0)];
		const concurrent = [
			review('e1', 'i1', 2000, 3, 'dev-a'),
			review('e2', 'i1', 3000, 1, 'dev-b'),
			review('e3', 'i1', 4000, 4, 'dev-a')
		];
		const forwards = await apply([...setup, ...concurrent]);
		const backwards = await apply([...setup, ...[...concurrent].reverse()]);

		expect(forwards.reviews).toHaveLength(3);
		expect(deriveCard(0, backwards.reviews)).toEqual(deriveCard(0, forwards.reviews));
	});

	it('applies a review of a word deleted elsewhere to nothing', async () => {
		const state = await converges(
			[addItem('i1')],
			[
				review('e1', 'i1', 2000, 3, 'dev-a'),
				(store) => store.commit(events.itemDeleted({ itemId: 'i1' }))
			]
		);
		expect(state.items).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
	});

	it('keeps a review that arrives before the item it belongs to', async () => {
		// A deviation from `sync/apply.ts`, in the direction §1 asks for ("no
		// lost reviews"): the old engine dropped an orphan review outright.
		const state = await converges([], [addItem('i1'), review('e1', 'i1', 2000, 3, 'dev-a')]);
		expect(state.reviews).toHaveLength(1);
	});
});

describe('§4 amend', () => {
	it('supersedes the original whichever of the two lands first', async () => {
		const amend: Commit = (store) =>
			store.commit(
				events.reviewAmended({
					eventId: 'e2',
					itemId: 'i1',
					at: 2500,
					grade: 1,
					device: 'dev-a',
					replaces: 2000
				})
			);

		const state = await converges([addItem('i1')], [review('e1', 'i1', 2000, 3, 'dev-a'), amend]);
		expect(state.reviews).toHaveLength(1);
		expect(state.reviews[0]).toMatchObject({ at: 2500, grade: 1 });
	});

	it('appends when there was nothing to replace', async () => {
		const state = await apply([
			addItem('i1'),
			(store) =>
				store.commit(
					events.reviewAmended({ eventId: 'e1', itemId: 'i1', at: 2500, grade: 2, device: 'dev-a' })
				)
		]);
		expect(state.reviews).toHaveLength(1);
	});
});

describe('§4 last-write-wins', () => {
	it('lets the greatest `at` win regardless of materialization order', async () => {
		const state = await converges(
			[addItem('i1')],
			[patch('e1', 3000, 'dev-a', 'newer'), patch('e2', 2000, 'dev-b', 'older')]
		);
		expect(state.items[0].notes).toBe('newer');
	});

	it('breaks an `at` tie by device, deterministically', async () => {
		const state = await converges(
			[addItem('i1')],
			[patch('e1', 3000, 'dev-a', 'from a'), patch('e2', 3000, 'dev-b', 'from b')]
		);
		expect(state.items[0].notes).toBe('from b');
	});

	it('does not let an absent field of the winning patch blank a set one', async () => {
		// LWW is per *item*, not per field (see `itemUpdates` in `sync/apply.ts`):
		// the winning patch writes only the fields it carries, and leaves the rest
		// as the previous winner left them.
		const state = await apply([
			addItem('i1'),
			patch('e1', 2000, 'dev-a', 'kept'),
			(store) =>
				store.commit(
					events.itemUpdated({
						eventId: 'e2',
						itemId: 'i1',
						at: 3000,
						device: 'dev-a',
						fields: { term: '水' }
					})
				)
		]);
		expect(state.items[0]).toMatchObject({ term: '水', notes: 'kept' });
	});

	it('resolves the profile the same way', async () => {
		const profile =
			(eventId: string, at: number, device: string, model: string): Commit =>
			(store) =>
				store.commit(
					events.profileUpdated({
						eventId,
						at,
						device,
						nativeLanguage: 'nl',
						targetLanguage: 'Mandarin Chinese',
						level: 'beginner',
						interests: ['food'],
						model,
						createdAt: 1
					})
				);

		const state = await converges(
			[],
			[profile('e1', 3000, 'dev-a', 'newer'), profile('e2', 2000, 'dev-b', 'older')]
		);
		expect(state.profile).toHaveLength(1);
		expect(state.profile[0].model).toBe('newer');
	});
});

describe('§4 challenges and results', () => {
	it('counts distinct serve events, not repeated deliveries of one', async () => {
		const serve =
			(eventId: string, at: number): Commit =>
			(store) =>
				store.commit(events.challengeServed({ eventId, challengeId: 'c1', at }));

		const state = await converges(
			[addChallenge('c1')],
			[serve('s1', 100), serve('s2', 300), serve('s1', 100)]
		);

		expect(serveStats(state.serves)).toEqual({ timesServed: 2, lastServedAt: 300 });
	});

	it('set-unions results by event id', async () => {
		// Two genuinely identical answers — same challenge, same typo, same
		// millisecond — are two results; the same event twice is one.
		const result =
			(eventId: string): Commit =>
			(store) =>
				store.commit(
					events.resultLogged({
						eventId,
						challengeId: 'c1',
						verdict: 'wrong',
						answerGiven: 'teh',
						at: 900
					})
				);

		const state = await converges([addChallenge('c1')], [result('r1'), result('r2'), result('r1')]);
		expect(state.results).toHaveLength(2);
	});

	it('keeps challenge content verbatim through the JSON column', async () => {
		const state = await apply([addChallenge('c1')]);
		expect(state.challenges[0].content).toMatchObject({
			id: 'c1',
			type: 'cloze',
			prompt: 'kept verbatim'
		});
	});

	it('drops a challenge type this build cannot play', async () => {
		const state = await apply([addChallenge('c1', 'listening-comprehension')]);
		expect(state.challenges).toHaveLength(0);
	});

	it('reports stickily, and no-ops on a challenge it has never seen', async () => {
		const state = await apply([
			addChallenge('c1'),
			(store) => store.commit(events.challengeReported({ challengeId: 'c1' })),
			(store) => store.commit(events.challengeReported({ challengeId: 'c1' })),
			(store) => store.commit(events.challengeReported({ challengeId: 'nope' }))
		]);
		expect(state.challenges[0].reported).toBe(true);
	});
});

describe('§3 retired events', () => {
	it('is configured to ignore an event type it has never heard of', async () => {
		// `xp-banked` is retired (§3) and old logs still carry it; §1's
		// degrade-silently rule says such a log must stay replayable. In 0.4 that
		// is a schema setting rather than something an apply engine must remember.
		//
		// NB this asserts the *configuration*, not the behaviour. The setting is
		// consulted when an event arrives from the eventlog with no matching
		// definition, which needs a second client syncing in — not reachable from
		// a single in-memory store, so the behaviour itself is unverified here.
		expect(schema.unknownEventHandling).toEqual({ strategy: 'ignore' });
	});
});
