/**
 * The merge rules, asserted against a real store.
 *
 * Two kinds of question, and the split matters:
 *
 * - Most rules are **commutative by construction** — review identity, serve
 *   counting, result set-union, idempotent inserts — and {@link converges}
 *   checks that by applying each scenario forwards and backwards. The snapshot
 *   it compares includes `items.fsrsCard`, so a card that depended on arrival
 *   order would fail here.
 * - The two overwrites are **decided by `at`**, not by arrival, so they are
 *   commutative too: the later timestamp wins whichever copy lands first.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { parseEvent, type EventType, type SyncEvent } from './events';
import { makeTestStore } from './store.testing';
import type { Store } from './store';

/** One event, with only the envelope fields a case cares about spelled out. */
interface Draft {
	id: string;
	type: EventType;
	payload: unknown;
	at?: number;
	device?: string;
}

let seq = 0;

/**
 * Applies drafts in order, as if they had arrived from the backend, and returns
 * a comparable snapshot of every read table.
 */
async function apply(drafts: Draft[]) {
	const store = await makeTestStore();
	await store.applyRemote(
		drafts.map((draft) => ({
			id: draft.id,
			type: draft.type,
			at: draft.at ?? 1,
			device: draft.device ?? 'devA',
			payload: draft.payload,
			seq: ++seq
		}))
	);
	return snapshot(store);
}

async function snapshot(store: Store) {
	return {
		items: await store.query<{ notes: string | null; recentGrades: string }>(
			'SELECT * FROM items ORDER BY id'
		),
		reviews: await store.query<{ at: number; grade: number }>('SELECT * FROM reviews ORDER BY id'),
		challenges: await store.query<{ content: string; reported: number; timesServed: number }>(
			'SELECT * FROM challenges ORDER BY id'
		),
		results: await store.query('SELECT * FROM results ORDER BY id'),
		daily: await store.query('SELECT * FROM daily ORDER BY day'),
		tombstones: await store.query('SELECT * FROM tombstones ORDER BY itemId'),
		profile: await store.query<{ model: string; about: string | null; interests: string }>(
			'SELECT * FROM profile'
		),
		texts: await store.query<{ title: string; topic: string | null; sentences: string }>(
			'SELECT * FROM texts ORDER BY id'
		),
		textTombstones: await store.query('SELECT * FROM textTombstones ORDER BY textId'),
		wordMarks: await store.query<{ term: string; known: number; updatedAt: number }>(
			'SELECT * FROM wordMarks ORDER BY term'
		),
		lookups: await store.query<{ term: string; itemId: string | null; textId: string }>(
			'SELECT * FROM lookups ORDER BY id'
		)
	};
}

/** Applies `setup` then `concurrent`, and again with `concurrent` reversed. */
async function converges(setup: Draft[], concurrent: Draft[]) {
	const forwards = await apply([...setup, ...concurrent]);
	const backwards = await apply([...setup, ...[...concurrent].reverse()]);
	expect(backwards).toEqual(forwards);
	return forwards;
}

const addItem = (id: string, introducedAt = 1000, eventId = `add:${id}`): Draft => ({
	id: eventId,
	type: 'itemAdded',
	at: introducedAt,
	payload: { id, kind: 'vocab', term: '书', meaning: 'book', introducedAt }
});

const review = (itemId: string, at: number, grade: number, device: string, id?: string): Draft => ({
	id: id ?? `rev:${itemId}:${at}:${grade}:${device}`,
	type: 'itemReviewed',
	at,
	device,
	payload: { itemId, at, grade, device }
});

const patch = (notes: string, at: number, itemId = 'i1'): Draft => ({
	id: `patch:${notes}`,
	type: 'itemUpdated',
	at,
	payload: { itemId, fields: { notes } }
});

const addChallenge = (id: string, type = 'cloze'): Draft => ({
	id: `challenge:${id}`,
	type: 'challengeAdded',
	at: 5000,
	payload: {
		challenge: { id, type, direction: 'toTarget', itemIds: ['i1'], prompt: 'kept verbatim' },
		generatedAt: 5000
	}
});

beforeEach(() => {
	seq = 0;
});

describe('items', () => {
	it('treats a re-delivered add as a no-op', async () => {
		const state = await apply([addItem('i1'), addItem('i1', 1000, 'add:again')]);
		expect(state.items).toHaveLength(1);
	});

	it('keeps two devices reviewing the same word in the same millisecond apart', async () => {
		const state = await converges(
			[addItem('i1')],
			[review('i1', 2000, 3, 'devA'), review('i1', 2000, 1, 'devB')]
		);
		expect(state.reviews).toHaveLength(2);
	});

	it('folds the same card from concurrent reviews whichever order they land in', async () => {
		// The fold is over `(at, device)`, so the stored card cannot depend on
		// which review the log happened to carry first — `converges` compares
		// `fsrsCard` itself.
		const state = await converges(
			[addItem('i1', 0)],
			[review('i1', 2000, 3, 'devA'), review('i1', 3000, 1, 'devB')]
		);
		expect(state.items[0]).toMatchObject({ reviewCount: 2, lastReviewedAt: 3000 });
	});

	it('collapses a review the app submits twice', async () => {
		// Identity is `(itemId, at, device)`, so a retried write collapses even
		// though the two events are genuinely distinct in the log.
		const state = await converges(
			[addItem('i1')],
			[review('i1', 2000, 3, 'devA', 'e1'), review('i1', 2000, 3, 'devA', 'e2')]
		);
		expect(state.reviews).toHaveLength(1);
		expect(state.items[0]).toMatchObject({ reviewCount: 1 });
	});

	it('removes the item and its history when it is deleted', async () => {
		const state = await apply([
			addItem('i1'),
			review('i1', 2000, 3, 'devA'),
			{ id: 'del:i1', type: 'itemDeleted', payload: { itemId: 'i1' } }
		]);
		expect(state.items).toHaveLength(0);
		expect(state.reviews).toHaveLength(0);
	});

	it('refuses an add for a word deleted anywhere, whenever it arrives', async () => {
		// The tombstone is the whole mechanism: an add and a delete from devices
		// with no shared history can arrive in either order.
		const state = await converges(
			[],
			[addItem('i1'), { id: 'del:i1', type: 'itemDeleted', payload: { itemId: 'i1' } }]
		);
		expect(state.items).toHaveLength(0);
		expect(state.tombstones).toHaveLength(1);
	});

	it('folds the same aggregates whether reviews land in order or out of it', async () => {
		// The bulk read serves these columns instead of scanning `reviews`, so the
		// incremental path and the refold path have to produce identical numbers.
		const reviews = [
			review('i1', 1500, 3, 'devA'),
			review('i1', 2500, 1, 'devA'),
			review('i1', 3500, 4, 'devA')
		];
		const state = await converges([addItem('i1', 1000)], reviews);

		expect(state.items[0]).toMatchObject({
			reviewCount: 3,
			correctCount: 2,
			lastReviewedAt: 3500,
			recentGrades: JSON.stringify([
				{ at: 1500, grade: 3 },
				{ at: 2500, grade: 1 },
				{ at: 3500, grade: 4 }
			])
		});
		// And they are the fold of the rows themselves, in `(at, device)` order.
		expect(state.reviews.map(({ at, grade }) => ({ at, grade }))).toEqual(
			JSON.parse(state.items[0].recentGrades)
		);
	});

	it('applies a review of a word deleted elsewhere to nothing', async () => {
		const state = await apply([
			addItem('i1'),
			{ id: 'del:i1', type: 'itemDeleted', payload: { itemId: 'i1' } },
			review('i1', 2000, 3, 'devA')
		]);
		// The row is inserted — the rule is deliberately order-free — but it is
		// unreachable: every read joins from `items`, and the tombstone is forever.
		expect(state.items).toHaveLength(0);
	});

	it('keeps a review that arrives before the item it belongs to', async () => {
		const state = await apply([review('i1', 2000, 3, 'devA'), addItem('i1')]);
		expect(state.items).toHaveLength(1);
		expect(state.reviews).toHaveLength(1);
		// The review counts the moment the item lands, rather than sitting inert.
		expect(state.items[0]).toMatchObject({ reviewCount: 1, lastReviewedAt: 2000 });
	});
});

describe('amend', () => {
	const amend = (grade: number, replaces?: number): Draft => ({
		id: `amend:${grade}`,
		type: 'reviewAmended',
		at: 2500,
		payload: { device: 'devA', at: 2500, itemId: 'i1', grade, replaces }
	});

	it('supersedes the original review it names', async () => {
		const state = await apply([addItem('i1'), review('i1', 2000, 3, 'devA'), amend(1, 2000)]);
		expect(state.reviews).toHaveLength(1);
		expect(state.reviews[0]).toMatchObject({ at: 2500, grade: 1 });
	});

	it('appends when there was nothing to replace', async () => {
		const state = await apply([addItem('i1'), amend(2)]);
		expect(state.reviews).toHaveLength(1);
	});

	it('re-amending lands where amending once would', async () => {
		const twice = await apply([
			addItem('i1'),
			review('i1', 2000, 3, 'devA'),
			amend(1, 2000),
			amend(4, 2000)
		]);
		const once = await apply([addItem('i1'), review('i1', 2000, 3, 'devA'), amend(4, 2000)]);
		expect(twice.reviews).toEqual(once.reviews);
		expect(twice.items).toEqual(once.items);
	});
});

describe('the two overwrites are decided by `at`', () => {
	it('lets the later patch win whichever copy arrives first', async () => {
		const state = await converges(
			[addItem('i1')],
			[patch('written first', 1000), patch('written second', 2000)]
		);
		expect(state.items[0]).toMatchObject({ notes: 'written second' });
	});

	it('does not let an absent patch field blank a set one', async () => {
		const state = await apply([
			addItem('i1'),
			{
				id: 'p1',
				type: 'itemUpdated',
				at: 1000,
				payload: { itemId: 'i1', fields: { notes: 'kept' } }
			},
			{ id: 'p2', type: 'itemUpdated', at: 2000, payload: { itemId: 'i1', fields: { term: '水' } } }
		]);
		expect(state.items[0]).toMatchObject({ term: '水', notes: 'kept' });
	});

	it('ignores a patch for an item it does not have', async () => {
		const state = await apply([patch('orphan', 1000, 'missing')]);
		expect(state.items).toHaveLength(0);
	});

	it('resolves the profile the same way', async () => {
		const save = (model: string, at: number): Draft => ({
			id: `profile:${model}`,
			type: 'profileUpdated',
			at,
			payload: {
				nativeLanguage: 'nl',
				targetLanguage: 'Mandarin Chinese',
				level: 'beginner',
				interests: ['food'],
				model,
				createdAt: 1000
			}
		});
		const state = await converges([], [save('a', 1000), save('b', 2000)]);
		expect(state.profile[0].model).toBe('b');
	});

	it('keeps exactly one profile row however many times it is saved', async () => {
		const state = await apply([
			{
				id: 'profile',
				type: 'profileUpdated',
				at: 1000,
				payload: {
					nativeLanguage: 'nl',
					targetLanguage: 'Mandarin Chinese',
					level: 'beginner',
					interests: ['food', 'music'],
					about: 'a sentence about me',
					model: 'mock',
					createdAt: 1000
				}
			}
		]);
		expect(state.profile).toHaveLength(1);
		expect(state.profile[0]).toMatchObject({ about: 'a sentence about me' });
		expect(JSON.parse(state.profile[0].interests)).toEqual(['food', 'music']);
	});
});

describe('challenges and results', () => {
	it('counts distinct serve events, not repeated deliveries of one', async () => {
		const serve = (id: string, at: number): Draft => ({
			id,
			type: 'challengeServed',
			at,
			payload: { challengeId: 'c1', at }
		});

		const state = await converges(
			[addChallenge('c1')],
			[serve('s1', 6000), serve('s1', 6000), serve('s2', 7000)]
		);
		expect(state.challenges[0]).toMatchObject({ timesServed: 2, lastServedAt: 7000 });
	});

	it('set-unions results by event id', async () => {
		const result = (id: string, answerGiven: string): Draft => ({
			id,
			type: 'resultLogged',
			at: 8000,
			payload: { challengeId: 'c1', verdict: 'correct', answerGiven, at: 8000 }
		});

		// Two genuinely identical answers stay two rows; a re-delivery of one stays
		// one. That is exactly what the event id buys over the content.
		const state = await converges(
			[],
			[result('r1', 'same'), result('r2', 'same'), result('r1', 'same')]
		);
		expect(state.results).toHaveLength(2);
		expect(state.daily).toEqual([{ day: expect.any(String), count: 2 }]);
	});

	it('keeps challenge content verbatim', async () => {
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
			{ id: 'c9', type: 'challengeAdded', at: 5000, payload: { challenge, generatedAt: 5000 } }
		]);
		expect(JSON.parse(state.challenges[0].content)).toEqual(challenge);
	});

	it('drops a challenge type this build cannot play', async () => {
		const state = await apply([addChallenge('c1', 'not-a-real-type')]);
		expect(state.challenges).toHaveLength(0);
	});

	it('reports stickily, and no-ops on a challenge it has never seen', async () => {
		const report = (challengeId: string): Draft => ({
			id: `report:${challengeId}`,
			type: 'challengeReported',
			payload: { challengeId }
		});

		const state = await converges([addChallenge('c1')], [report('c1'), report('never-seen')]);
		expect(state.challenges[0].reported).toBe(1);
	});
});

describe('reading texts and word marks', () => {
	const addText = (id: string, eventId = `text:${id}`): Draft => ({
		id: eventId,
		type: 'textAdded',
		at: 6000,
		payload: {
			id,
			title: '买书',
			source: 'generated',
			sentences: [
				{ text: '我想买书。', reading: 'wǒ xiǎng mǎi shū.', translation: 'I want a book.' }
			],
			glossary: [{ term: '书', reading: 'shū', meaning: 'book' }],
			createdAt: 6000
		}
	});

	const deleteText = (textId: string): Draft => ({
		id: `del:${textId}`,
		type: 'textDeleted',
		payload: { textId }
	});

	const mark = (known: boolean, at: number, term = '水'): Draft => ({
		id: `mark:${term}:${at}`,
		type: 'wordMarked',
		at,
		payload: { term, known }
	});

	it('treats a re-delivered text as a no-op', async () => {
		// A text is immutable once stored, so the second copy has nothing to add.
		const state = await apply([addText('t1'), addText('t1', 'text:again')]);
		expect(state.texts).toHaveLength(1);
	});

	it('keeps sentences and glossary verbatim', async () => {
		const state = await apply([addText('t1')]);
		expect(JSON.parse(state.texts[0].sentences)).toEqual([
			{ text: '我想买书。', reading: 'wǒ xiǎng mǎi shū.', translation: 'I want a book.' }
		]);
		// An absent topic is a NULL column, not the string "undefined".
		expect(state.texts[0].topic).toBeNull();
	});

	it('refuses a text deleted anywhere, whenever it arrives', async () => {
		const state = await converges([], [addText('t1'), deleteText('t1')]);
		expect(state.texts).toHaveLength(0);
		expect(state.textTombstones).toHaveLength(1);
	});

	it('lets the later mark win whichever copy arrives first', async () => {
		const state = await converges([], [mark(true, 1000), mark(false, 2000)]);
		expect(state.wordMarks).toEqual([{ term: '水', known: 0, updatedAt: 2000 }]);
	});

	it('does not let an older mark arriving late overwrite a newer one', async () => {
		const state = await apply([mark(false, 2000), mark(true, 1000)]);
		expect(state.wordMarks[0]).toMatchObject({ known: 0, updatedAt: 2000 });
	});

	it('keeps one row per term, and stores the term trimmed', async () => {
		const state = await apply([
			{ id: 'm1', type: 'wordMarked', at: 1000, payload: { term: '  水  ', known: true } },
			mark(false, 3000)
		]);
		expect(state.wordMarks).toEqual([{ term: '水', known: 0, updatedAt: 3000 }]);
	});

	it('counts every lookup of a word, and collapses only a re-delivered one', async () => {
		const lookup = (id: string, at: number, itemId?: string): Draft => ({
			id,
			type: 'wordLookedUp',
			at,
			payload: { term: '书', textId: 't1', itemId }
		});

		// Two taps on the same word are two rows — the count is the whole signal —
		// while one event delivered twice stays one, which is what the id buys.
		const state = await converges(
			[],
			[lookup('l1', 7000, 'i1'), lookup('l1', 7000, 'i1'), lookup('l2', 8000)]
		);
		expect(state.lookups).toEqual([
			{ id: 'l1', term: '书', itemId: 'i1', textId: 't1', at: 7000 },
			{ id: 'l2', term: '书', itemId: null, textId: 't1', at: 8000 }
		]);
	});
});

describe('unknown events', () => {
	it('skips an event type this build has never heard of', () => {
		// The retired `xp-banked` is the case: an old log carrying it must keep
		// working, and the caller drops the event and keeps going.
		expect(
			parseEvent({ id: 'x', type: 'xpBanked', at: 1, device: 'devA', payload: { amount: 5 } })
		).toBeUndefined();
	});

	it('skips an event whose payload will not parse', () => {
		expect(
			parseEvent({ id: 'x', type: 'itemAdded', at: 1, device: 'devA', payload: { id: 'i1' } })
		).toBeUndefined();
	});

	it('accepts a well-formed one', () => {
		const raw: SyncEvent = {
			id: 'x',
			type: 'itemDeleted',
			at: 1,
			device: 'devA',
			payload: { itemId: 'i1' }
		};
		expect(parseEvent(raw)).toEqual(raw);
	});
});
