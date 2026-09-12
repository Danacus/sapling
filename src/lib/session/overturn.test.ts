/**
 * The database-touching engine functions worth a test, because each one decides
 * what happens to a learner's SRS card and getting any of them wrong corrupts
 * scheduling silently: `applyResult` (the grade, and which items it filed one
 * for), `amendResult` (the learner re-rated a correct answer) and
 * `applyOverturn` (a dispute was won) — plus `updateItemAfterReview` itself,
 * which is the one call all three go through.
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

import { beforeEach, describe, expect, it } from 'vitest';

import { getItem, updateItemAfterReview } from '$lib/db';
import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend, type TestBackend } from '$lib/db/backend.testing';
import { CardState, Grade } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { Challenge } from '$lib/types';

import { amendResult, applyOverturn, applyResult } from './engine';

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

		// Easy is the learner's to give now — nothing here infers it.
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

describe('amendResult', () => {
	/** Plays a correct answer through `applyResult`, as the session would. */
	async function answeredCorrectly(): Promise<Set<string>> {
		await seed('i1');
		return applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });
	}

	/**
	 * The card a fresh item lands on after a single review of `grade` at
	 * {@link NOW} — the same store, folding the same one-review history.
	 *
	 * The expectation is drawn from the core because there is nowhere else to
	 * draw it from: an FSRS card is the core's to compute, and this file's job is
	 * to check that a re-grade *lands* on the single-review card rather than on
	 * a stack of two.
	 */
	async function foldedAlone(id: string, grade: Grade): Promise<FsrsCardState | undefined> {
		await seed(id);
		await updateItemAfterReview(id, { at: NOW, grade });
		return cardOf(id);
	}

	it('rewrites the review instead of stacking a second one', async () => {
		const reviewed = await answeredCorrectly();
		expect(await historyOf('i1')).toHaveLength(1);

		await amendResult(single, Grade.Easy, reviewed, NOW);

		expect(await historyOf('i1')).toEqual([{ at: NOW, grade: Grade.Easy }]);
		// The card follows the rewritten history: one Easy review, not a Good
		// with an Easy stacked on top of it.
		expect(await cardOf('i1')).toEqual(await foldedAlone('ref', Grade.Easy));
	});

	it('amending twice equals amending once with the last grade', async () => {
		const reviewed = await answeredCorrectly();

		await amendResult(single, Grade.Easy, reviewed, NOW);
		await amendResult(single, Grade.Hard, reviewed, NOW);

		expect(await historyOf('i1')).toEqual([{ at: NOW, grade: Grade.Hard }]);
		expect(await cardOf('i1')).toEqual(await foldedAlone('ref', Grade.Hard));
	});

	it('leaves items the review skipped, and match-pairs rounds, untouched', async () => {
		const reviewed = await answeredCorrectly();
		// Present on the challenge but absent from the set: never reviewed.
		await seed('i2');

		await amendResult({ ...cloze, itemIds: ['i1', 'i2'] }, Grade.Easy, reviewed, NOW);
		expect(await historyOf('i2')).toEqual([]);

		await amendResult(match, Grade.Easy, reviewed, NOW);
		expect(await historyOf('i1')).toHaveLength(1);
	});

	it('re-grades every reviewed multi-cloze item after an all-correct passage', async () => {
		await seed('i1');
		await seed('i2');
		const reviewed = await applyResult(multiCloze, {
			verdict: 'correct',
			answerGiven: '1: Yo · 2: Ella',
			itemVerdicts: [
				{ itemId: 'i1', verdict: 'correct' },
				{ itemId: 'i2', verdict: 'correct' }
			],
			now: NOW
		});

		await amendResult(multiCloze, Grade.Easy, reviewed, NOW);
		expect((await historyOf('i1')).at(-1)?.grade).toBe(Grade.Easy);
		expect((await historyOf('i2')).at(-1)?.grade).toBe(Grade.Easy);
	});
});

describe('applyOverturn', () => {
	it('writes one Good review per item on the challenge', async () => {
		await seed('i1');
		await seed('i2');

		await applyOverturn(cloze, NOW);

		for (const id of ['i1', 'i2']) {
			expect(await historyOf(id)).toEqual([{ at: NOW, grade: Grade.Good }]);
			const card = (await cardOf(id)) as FsrsCardState;
			// A Good review schedules the card into the future.
			expect(card.due).toBeGreaterThan(NOW);
			expect(card.reps).toBe(1);
		}
	});

	it('stacks on top of the Again review the wrong answer already wrote', async () => {
		await seed('i1');
		// What `applyResult` leaves behind for a wrong answer.
		await applyResult(
			{ ...cloze, itemIds: ['i1'] },
			{
				verdict: 'wrong',
				answerGiven: 'como',
				now: NOW - 1000
			}
		);

		await applyOverturn({ ...cloze, itemIds: ['i1'] }, NOW);

		// The lapse is not rewritten — the compensating review is appended to it.
		expect(await historyOf('i1')).toEqual([
			{ at: NOW - 1000, grade: Grade.Again },
			{ at: NOW, grade: Grade.Good }
		]);
	});

	it('only compensates the multi-cloze items that were actually wrong', async () => {
		await seed('i1');
		await seed('i2');
		await applyResult(multiCloze, {
			verdict: 'wrong',
			answerGiven: '1: Yo · 2: Tú',
			itemVerdicts: [
				{ itemId: 'i1', verdict: 'correct' },
				{ itemId: 'i2', verdict: 'wrong' }
			],
			now: NOW - 1000
		});

		await applyOverturn(multiCloze, NOW, new Set(['i2']));

		expect(await historyOf('i1')).toEqual([{ at: NOW - 1000, grade: Grade.Good }]);
		expect(await historyOf('i2')).toEqual([
			{ at: NOW - 1000, grade: Grade.Again },
			{ at: NOW, grade: Grade.Good }
		]);
	});

	it('skips items that no longer exist, and match-pairs rounds entirely', async () => {
		await seed('i1');

		await applyOverturn({ ...cloze, itemIds: ['i1', 'gone'] }, NOW);
		expect(await historyOf('i1')).toHaveLength(1);
		expect(await getItem('gone')).toBeUndefined();

		await applyOverturn(match, NOW);
		// Still just the one review from the cloze above.
		expect(await historyOf('i1')).toHaveLength(1);
	});
});
