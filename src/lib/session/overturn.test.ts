/**
 * The database-touching engine functions worth a test, because each one decides
 * what happens to a learner's SRS card and getting any of them wrong corrupts
 * scheduling silently: `applyResult` (the grade, and which items it filed one
 * for) and `applyOverturn` (a dispute was won, and undone exactly) — plus
 * `updateItemAfterReview` itself, which is the one call both go through.
 *
 * They run against a **real store** — the same WASM SQLite and the same merge
 * rules the browser runs, in memory. So what is asserted below is the behaviour
 * the app actually has, not a second implementation's impression of it. That is
 * the only way left to assert a card at all: the frontend runs no FSRS, so
 * every card in this file came out of the core.
 *
 * A card that has never been reviewed is a fresh card rather than `null`, and a
 * re-grade moves it by rewriting one review and letting the core refold, never
 * by overwriting a stored card with an arithmetic result.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	addToPool,
	getItem,
	getPool,
	getRatings,
	recentResults,
	updateItemAfterReview
} from '$lib/db';
import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend, type TestBackend } from '$lib/db/backend.testing';
import { CardState, Grade } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { Challenge } from '$lib/types';

import { applyOverturn, applyResult } from './engine';

const NOW = 1_700_000_000_000;

let store: TestBackend;

beforeEach(async () => {
	store = await makeTestBackend();
	setBackendForTesting(store);
});

/** Adds one item, introduced at {@link NOW} with no reviews. */
async function seed(id: string): Promise<void> {
	await store.commit('itemAdded', {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		introducedAt: NOW
	});
}

/** One item's history, without the device stamp the assertions do not care about. */
async function historyOf(id: string): Promise<{ at: number; grade: number }[]> {
	const item = await getItem(id);
	return (item?.history ?? []).map(({ at, grade }) => ({ at, grade }));
}

async function cardOf(id: string): Promise<FsrsCardState | undefined> {
	return (await getItem(id))?.fsrsCard as FsrsCardState | undefined;
}

const cloze: Challenge = {
	id: 'c1',
	type: 'cloze',
	direction: 'toTarget',
	sentence: 'Yo ___ un libro.',
	acceptedAnswers: ['leo'],
	translationHint: 'I read a book.',
	itemIds: ['i1', 'i2']
};

/** The single-item cloze most of the tests below grade against. */
const single: Challenge = { ...cloze, itemIds: ['i1'] };

const match: Challenge = {
	id: 'm1',
	type: 'match-pairs',
	direction: 'toNative',
	itemIds: ['i1'],
	pairs: [
		{ a: 'el perro', b: 'the dog' },
		{ a: 'leer', b: 'to read' }
	]
};

const multiCloze: Challenge = {
	id: 'mc1',
	type: 'multi-cloze',
	direction: 'toTarget',
	passage: '___1___ leo. ___2___ bebe.',
	gaps: [
		{ itemId: 'i1', acceptedAnswers: ['Yo'] },
		{ itemId: 'i2', acceptedAnswers: ['Ella'] }
	],
	wordBank: ['Yo', 'Ella', 'Tú', 'nosotros', 'ellos'],
	itemIds: ['i1', 'i2']
};

describe('applyResult', () => {
	/** The grade written for a fast, correct answer to `challenge`. */
	async function gradeFor(challenge: Challenge): Promise<number | undefined> {
		store = await makeTestBackend();
		setBackendForTesting(store);
		await seed('i1');
		await applyResult(challenge, {
			verdict: 'correct',
			answerGiven: 'leo',
			responseMs: 200,
			now: NOW
		});
		return (await historyOf('i1')).at(-1)?.grade;
	}

	it('grades every correct answer Good, whatever the format and however fast', async () => {
		const mc: Challenge = {
			id: 'c1',
			type: 'multiple-choice',
			direction: 'toTarget',
			prompt: 'to read',
			options: ['leo', 'como', 'bebo', 'corro'],
			correctIndex: 0,
			itemIds: ['i1']
		};
		const typed: Challenge = {
			id: 'c2',
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'I read a book.',
			acceptedAnswers: ['leo un libro'],
			itemIds: ['i1']
		};
		const banked: Challenge = { ...single, wordBank: ['leo', 'como', 'bebo'] };

		// Nothing infers Easy from an answer.
		for (const challenge of [mc, typed, banked, single]) {
			expect(await gradeFor(challenge)).toBe(Grade.Good);
		}
	});

	it('grades almost Hard and wrong Again', async () => {
		await seed('i1');
		await applyResult(single, { verdict: 'almost', answerGiven: 'leó', now: NOW });
		expect((await historyOf('i1')).at(-1)?.grade).toBe(Grade.Hard);

		store = await makeTestBackend();
		setBackendForTesting(store);
		await seed('i1');
		await applyResult(single, { verdict: 'wrong', answerGiven: 'como', now: NOW });
		expect((await historyOf('i1')).at(-1)?.grade).toBe(Grade.Again);
	});

	it('returns the items it actually filed a review for', async () => {
		await seed('i1');
		await seed('i2');

		const reviewed = await applyResult(cloze, {
			verdict: 'correct',
			answerGiven: 'leo',
			now: NOW
		});

		expect([...reviewed].sort()).toEqual(['i1', 'i2']);
	});

	it('omits items that no longer exist, and returns nothing for match-pairs', async () => {
		await seed('i1');

		const reviewed = await applyResult(
			{ ...cloze, itemIds: ['i1', 'gone'] },
			{ verdict: 'correct', answerGiven: 'leo', now: NOW }
		);
		expect([...reviewed]).toEqual(['i1']);

		const none = await applyResult(match, { verdict: 'correct', answerGiven: '', now: NOW });
		expect(none.size).toBe(0);
	});

	it('files the reviews, the result and the serve stamp in one write', async () => {
		await seed('i1');
		await addToPool([single], NOW);
		const writes = vi.spyOn(store, 'recordAnswer');
		const piecemeal = [
			vi.spyOn(store, 'reviewItem'),
			vi.spyOn(store, 'addResult'),
			vi.spyOn(store, 'recordServe')
		];

		await applyResult(single, { verdict: 'correct', answerGiven: 'leo', shown: 'typed', now: NOW });

		expect(writes).toHaveBeenCalledTimes(1);
		for (const call of piecemeal) expect(call).not.toHaveBeenCalled();
		expect(await historyOf('i1')).toEqual([{ at: NOW, grade: Grade.Good }]);
		expect(await recentResults(1)).toEqual([
			{ challengeId: 'c1', verdict: 'correct', answerGiven: 'leo', at: NOW, shown: 'typed' }
		]);
		const [row] = await getPool();
		expect(row).toMatchObject({ timesServed: 1, lastServedAt: NOW });
	});

	it('grades each multi-cloze item from its own gap, while logging one overall verdict', async () => {
		await seed('i1');
		await seed('i2');

		await applyResult(multiCloze, {
			verdict: 'wrong',
			answerGiven: '1: Yo · 2: Tú',
			itemVerdicts: [
				{ itemId: 'i1', verdict: 'correct' },
				{ itemId: 'i2', verdict: 'wrong' }
			],
			now: NOW
		});

		expect((await historyOf('i1')).at(-1)?.grade).toBe(Grade.Good);
		expect((await historyOf('i2')).at(-1)?.grade).toBe(Grade.Again);
	});
});

describe('updateItemAfterReview', () => {
	it('answers with the card before the review and the card the core folded', async () => {
		await seed('i1');
		const before = await cardOf('i1');

		const { existed, prior, card } = await updateItemAfterReview('i1', {
			at: NOW,
			grade: Grade.Good
		});

		expect(existed).toBe(true);
		expect(prior).toEqual(before);
		// Read back, not predicted: it is exactly what the store now holds.
		expect(card).toEqual(await cardOf('i1'));
		expect(card).not.toEqual(before);
	});

	it('holds a fresh card for an item that has never been reviewed', async () => {
		await seed('i1');

		const { prior } = await updateItemAfterReview('i1', { at: NOW, grade: Grade.Good });

		// A card is derived, so it cannot be unset the way a stored column could:
		// an empty history folds to a new card at the item's `introducedAt`.
		expect(prior).toMatchObject({ state: CardState.New, reps: 0, due: NOW, last_review: null });
	});

	it('says an item is gone rather than throwing, with no cards either side', async () => {
		expect(await updateItemAfterReview('gone', { at: NOW, grade: Grade.Good })).toEqual({
			existed: false,
			prior: null,
			card: null
		});
	});
});

describe('applyOverturn', () => {
	/**
	 * The card a fresh item lands on after one review of `grade` at `at`: what
	 * an answer accepted on the spot leaves.
	 */
	async function foldedAlone(grade: Grade, at: number): Promise<FsrsCardState | undefined> {
		await seed('ref');
		await updateItemAfterReview('ref', { at, grade });
		return cardOf('ref');
	}

	it('supersedes the Again with a Good at the answer, as if accepted on the spot', async () => {
		await seed('i1');
		const reviewed = await applyResult(single, {
			verdict: 'wrong',
			answerGiven: 'como',
			now: NOW - 1000
		});

		const verdict = await applyOverturn(single, { answeredAt: NOW - 1000, reviewed });

		expect(verdict).toBe('correct');
		expect(await historyOf('i1')).toEqual([{ at: NOW - 1000, grade: Grade.Good }]);
		expect(await cardOf('i1')).toEqual(await foldedAlone(Grade.Good, NOW - 1000));
	});

	it('only overturns the multi-cloze gaps that were wrong, and counts the rest', async () => {
		await seed('i1');
		await seed('i2');
		const itemVerdicts = [
			{ itemId: 'i1', verdict: 'almost' as const },
			{ itemId: 'i2', verdict: 'wrong' as const }
		];
		const reviewed = await applyResult(multiCloze, {
			verdict: 'wrong',
			answerGiven: '1: Yó · 2: Tú',
			itemVerdicts,
			now: NOW - 1000
		});

		const verdict = await applyOverturn(multiCloze, {
			answeredAt: NOW - 1000,
			reviewed,
			itemVerdicts
		});

		expect(verdict).toBe('almost');
		expect(await historyOf('i1')).toEqual([{ at: NOW - 1000, grade: Grade.Hard }]);
		expect(await historyOf('i2')).toEqual([{ at: NOW - 1000, grade: Grade.Good }]);
	});

	it('logs the answer as overturned, so the difficulty model learns a success', async () => {
		await seed('i1');
		await seed('i2');
		const wrong = async (now: number) => {
			const reviewed = await applyResult(single, {
				verdict: 'wrong',
				answerGiven: 'como',
				shown: 'typed',
				now
			});
			return reviewed;
		};
		// Not pooled, the answer teaches nothing either way: pool the row first.
		await store.commit('challengeAdded', { challenge: single, generatedAt: NOW - 5000 });
		const reviewed = await wrong(NOW - 1000);
		const typedRating = async () =>
			(await getRatings()).find((r) => r.key === 'challenge:cloze/typed')!.value;
		const missed = await typedRating();

		await applyOverturn(single, { answeredAt: NOW - 1000, reviewed });

		// A success reads the type easier than the miss did.
		expect(await typedRating()).toBeLessThan(missed);
		// The result log keeps what was answered.
		expect((await recentResults(1))[0]).toMatchObject({ verdict: 'wrong', at: NOW - 1000 });
	});

	it('skips items the answer never reviewed, and match-pairs rounds entirely', async () => {
		await seed('i1');
		const reviewed = await applyResult(
			{ ...cloze, itemIds: ['i1', 'gone'] },
			{ verdict: 'wrong', answerGiven: 'como', now: NOW - 1000 }
		);

		await applyOverturn(
			{ ...cloze, itemIds: ['i1', 'gone'] },
			{ answeredAt: NOW - 1000, reviewed }
		);
		expect(await historyOf('i1')).toEqual([{ at: NOW - 1000, grade: Grade.Good }]);
		expect(await getItem('gone')).toBeUndefined();

		expect(await applyOverturn(match, { answeredAt: NOW, reviewed: new Set(['i1']) })).toBe(
			'correct'
		);
		expect(await historyOf('i1')).toHaveLength(1);
	});
});
