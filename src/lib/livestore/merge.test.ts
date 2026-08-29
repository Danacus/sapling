/**
 * `docs/sync.md` §4's merge rules, asserted against a real store.
 *
 * §4 used to promise convergence *regardless of arrival order*, and these
 * tests used to check it by applying each scenario in two orders. That promise
 * has been deliberately traded away: the eventlog now supplies one order, every
 * client materializes it, and "last write wins" means last in the log rather
 * than latest wall clock (see the ordering note in `materializers.ts`).
 *
 * So the suite asks two different questions instead:
 *
 * - For the rules that are **commutative by construction** — review identity,
 *   serve counting, result set-union, idempotent inserts — the old property
 *   still holds and is still checked with {@link converges}. These are the
 *   rules that never needed the total order in the first place.
 * - For the rules that are **order-decided** — the two overwrites — the tests
 *   assert both directions explicitly, which is the honest way to pin down a
 *   behaviour whose whole point is that order matters.
 */
import { describe, expect, it } from 'vitest';

import { deriveCard, serveStats } from './derive';
import { events, tables } from './schema';
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
 *
 * Only for the commutative rules. Reordering the causal prefix is never tested:
 * a device can only patch, review or delete an item it already holds, so the
 * add precedes those events in that device's own order, and a rebase preserves
 * a client's internal order while moving the block.
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
	(itemId: string, at: number, grade: number, device: string): Commit =>
	(store) =>
		store.commit(events.itemReviewed({ itemId, at, grade, device }));

const patch =
	(notes: string, itemId = 'i1'): Commit =>
	(store) =>
		store.commit(events.itemUpdated({ itemId, fields: { notes } }));

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
		const state = await apply([addItem('i1'), addItem('i1')]);
		expect(state.items).toHaveLength(1);
	});

	it('keeps two devices reviewing the same word in the same millisecond apart', async () => {
		const state = await converges(
			[addItem('i1')],
			[review('i1', 2000, 3, 'devA'), review('i1', 2000, 1, 'devB')]
		);
		expect(state.reviews).toHaveLength(2);
	});

	it('derives the same card from concurrent reviews whichever order they land in', async () => {
		const state = await converges(
			[addItem('i1', 0)],
			[review('i1', 2000, 3, 'devA'), review('i1', 3000, 1, 'devB')]
		);
		// The fold is over `(at, device)`, so the card cannot depend on which
		// review the log happened to carry first.
		const card = deriveCard(0, state.reviews);
		expect(card).toEqual(deriveCard(0, [...state.reviews].reverse()));
	});

	it('collapses a review the app submits twice', async () => {
		const state = await converges(
			[addItem('i1')],
			[review('i1', 2000, 3, 'devA'), review('i1', 2000, 3, 'devA')]
		);
		// Identity is `(itemId, at, device)`, so a retried write collapses even
		// though the two events are genuinely distinct in the log. Nothing about
		// the originating event is stored, which is what keeps the row identical
		// on every client no matter which copy arrived first.
		expect(state.reviews).toHaveLength(1);
	});

	it('removes the item and its history when it is deleted', async () => {
		const state = await apply([
			addItem('i1'),
			review('i1', 2000, 3, 'devA'),
			(store) => store.commit(events.itemDeleted({ itemId: 'i1' }))
		]);
		expect(state.items).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
	});

	it('applies a review of a word deleted elsewhere to nothing', async () => {
		const state = await apply([
			addItem('i1'),
			(store) => store.commit(events.itemDeleted({ itemId: 'i1' })),
			review('i1', 2000, 3, 'devA')
		]);
		// The row is inserted — the materializer is deliberately order-free — but
		// it is unreachable: every read joins from `items`, and the id is a UUID
		// that can never be minted again.
		expect(state.items).toHaveLength(0);
	});

	it('keeps a review that arrives before the item it belongs to', async () => {
		const state = await apply([review('i1', 2000, 3, 'devA'), addItem('i1')]);
		expect(state.items).toHaveLength(1);
		expect(state.reviews).toHaveLength(1);
	});
});

describe('§4 amend', () => {
	it('supersedes the original review it names', async () => {
		const state = await apply([
			addItem('i1'),
			review('i1', 2000, 3, 'devA'),
			(store) =>
				store.commit(
					events.reviewAmended({
						device: 'devA',
						at: 2500,
						itemId: 'i1',
						grade: 1,
						replaces: 2000
					})
				)
		]);
		expect(state.reviews).toHaveLength(1);
		expect(state.reviews[0]).toMatchObject({ at: 2500, grade: 1 });
	});

	it('appends when there was nothing to replace', async () => {
		const state = await apply([
			addItem('i1'),
			(store) =>
				store.commit(
					events.reviewAmended({
						device: 'devA',
						at: 2500,
						itemId: 'i1',
						grade: 2
					})
				)
		]);
		expect(state.reviews).toHaveLength(1);
	});

	it('re-amending lands where amending once would', async () => {
		const amend =
			(grade: number): Commit =>
			(store) =>
				store.commit(
					events.reviewAmended({
						device: 'devA',
						at: 2500,
						itemId: 'i1',
						grade,
						replaces: 2000
					})
				);
		const twice = await apply([addItem('i1'), review('i1', 2000, 3, 'devA'), amend(1), amend(4)]);
		const once = await apply([addItem('i1'), review('i1', 2000, 3, 'devA'), amend(4)]);
		expect(twice.reviews.map((r) => r.grade)).toEqual(once.reviews.map((r) => r.grade));
	});
});

describe('the two overwrites are decided by log order', () => {
	it('lets whichever patch is last in the log win', async () => {
		const first = await apply([addItem('i1'), patch('written first'), patch('written second')]);
		const second = await apply([addItem('i1'), patch('written second'), patch('written first')]);

		expect(first.items[0].notes).toBe('written second');
		// Reversed, the other one wins — which is the whole point of the change.
		// Under the old `(at, device, id)` rule the answer would have been the
		// same both times, decided by a timestamp neither device could audit.
		expect(second.items[0].notes).toBe('written first');
	});

	it('does not let an absent patch field blank a set one', async () => {
		const state = await apply([
			addItem('i1'),
			(store) => store.commit(events.itemUpdated({ itemId: 'i1', fields: { notes: 'kept' } })),
			(store) => store.commit(events.itemUpdated({ itemId: 'i1', fields: { term: '水' } }))
		]);
		expect(state.items[0]).toMatchObject({ term: '水', notes: 'kept' });
	});

	it('ignores a patch for an item it does not have', async () => {
		const state = await apply([patch('orphan', 'missing')]);
		expect(state.items).toHaveLength(0);
	});

	it('resolves the profile the same way', async () => {
		const save =
			(model: string): Commit =>
			(store) =>
				store.commit(
					events.profileUpdated({
						nativeLanguage: 'nl',
						targetLanguage: 'Mandarin Chinese',
						level: 'beginner',
						interests: ['food'],
						model,
						createdAt: 1000
					})
				);
		expect((await apply([save('a'), save('b')])).profile[0].model).toBe('b');
		expect((await apply([save('b'), save('a')])).profile[0].model).toBe('a');
	});

	it('keeps exactly one profile row however many times it is saved', async () => {
		const state = await apply([
			(store) =>
				store.commit(
					events.profileUpdated({
						nativeLanguage: 'nl',
						targetLanguage: 'Mandarin Chinese',
						level: 'beginner',
						interests: ['food', 'music'],
						about: 'a sentence about me',
						model: 'mock',
						createdAt: 1000
					})
				)
		]);
		expect(state.profile).toHaveLength(1);
		expect(state.profile[0]).toMatchObject({ about: 'a sentence about me' });
		expect([...state.profile[0].interests]).toEqual(['food', 'music']);
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
			[serve('s1', 6000), serve('s1', 6000), serve('s2', 7000)]
		);
		expect(serveStats(state.serves)).toEqual({ timesServed: 2, lastServedAt: 7000 });
	});

	it('set-unions results by event id', async () => {
		const result =
			(eventId: string, answerGiven: string): Commit =>
			(store) =>
				store.commit(
					events.resultLogged({
						eventId,
						challengeId: 'c1',
						verdict: 'correct',
						answerGiven,
						at: 8000
					})
				);

		// Two genuinely identical answers stay two rows; a re-delivery of one
		// stays one. That is exactly what the event id buys over the content.
		const state = await converges(
			[],
			[result('r1', 'same'), result('r2', 'same'), result('r1', 'same')]
		);
		expect(state.results).toHaveLength(2);
	});

	it('keeps challenge content verbatim through the JSON column', async () => {
		// The regression this guards: an Effect `Schema.Struct` strips unknown
		// keys on decode, so typing `challenge` as a struct would silently
		// amputate every field the schema did not name — while typechecking
		// perfectly. `Schema.Any` plus a JSON column is what keeps a challenge
		// body whole, and this asserts it with a realistic full-fat one.
		const challenge = {
			id: 'c9',
			type: 'cloze',
			direction: 'toTarget',
			itemIds: ['i1', 'i2'],
			prompt: '我想买___苹果。',
			answer: '三个',
			alternatives: ['三隻', '三粒'],
			readings: [
				{ term: '苹果', reading: 'píngguǒ' },
				{ term: '想买', reading: 'xiǎng mǎi' }
			],
			explanation: { short: 'measure word', long: 'a nested object, two levels down' },
			tags: ['shopping', 'numbers']
		};

		const state = await apply([
			(store) => store.commit(events.challengeAdded({ challenge, generatedAt: 5000 }))
		]);
		expect(state.challenges[0].content).toEqual(challenge);
	});

	it('drops a challenge type this build cannot play', async () => {
		const state = await apply([addChallenge('c1', 'not-a-real-type')]);
		expect(state.challenges).toHaveLength(0);
	});

	it('reports stickily, and no-ops on a challenge it has never seen', async () => {
		const report =
			(challengeId: string): Commit =>
			(store) =>
				store.commit(events.challengeReported({ challengeId }));

		const state = await converges([addChallenge('c1')], [report('c1'), report('never-seen')]);
		expect(state.challenges[0].reported).toBe(true);
	});
});

describe('§3 retired events', () => {
	it('is configured to ignore an event type it has never heard of', async () => {
		// §3 retired `xp-banked` and specified that old logs carrying it keep
		// working. This asserts the *setting*, not the behaviour: exercising it
		// for real needs a second client syncing an unknown event in, which one
		// in-memory store cannot stage.
		const { schema } = await import('./schema');
		expect(schema.unknownEventHandling).toEqual({ strategy: 'ignore' });
	});
});
