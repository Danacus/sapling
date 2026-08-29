/**
 * The database-touching engine functions worth a test, because each one decides
 * what happens to a learner's SRS card and getting any of them wrong corrupts
 * scheduling silently: `applyResult` (the grade, and the pre-review snapshot it
 * hands back), `amendResult` (the learner re-rated a correct answer) and
 * `applyOverturn` (a dispute was won).
 *
 * These used to run against a hand-written in-memory stand-in for `$lib/db`,
 * because IndexedDB does not exist in node. They now run against a **real
 * store** — the node adapter runs the same WASM SQLite and the same
 * materializers the browser does. So what is asserted below is the behaviour
 * the app actually has, not a second implementation's impression of it.
 *
 * One deliberate difference from the mock these replace: a card is no longer
 * *stored*, it is folded from the `reviews` table on read. An item that has
 * never been reviewed therefore has a fresh card rather than `null`, and a
 * re-grade moves the card by rewriting history rather than by overwriting a
 * stored card with an arithmetic result.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { getItem } from '$lib/db';
import { events } from '$lib/livestore/schema';
import { setStoreForTesting } from '$lib/livestore/store';
import { makeTestStore } from '$lib/livestore/store.testing';
import { Grade, newCardState, reviewCard } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { Challenge } from '$lib/types';

import { amendResult, applyOverturn, applyResult } from './engine';

const NOW = 1_700_000_000_000;

let store: Awaited<ReturnType<typeof makeTestStore>>;

beforeEach(async () => {
	store = await makeTestStore();
	setStoreForTesting(store);
});

/** Adds one item, introduced at {@link NOW} with no reviews. */
function seed(id: string): void {
	store.commit(
		events.itemAdded({
			id,
			kind: 'vocab',
			term: `term-${id}`,
			meaning: `meaning-${id}`,
			introducedAt: NOW
		})
	);
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

describe('applyResult', () => {
	/** The grade written for a fast, correct answer to `challenge`. */
	async function gradeFor(challenge: Challenge): Promise<number | undefined> {
		store = await makeTestStore();
		setStoreForTesting(store);
		seed('i1');
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
		seed('i1');
		await applyResult(single, { verdict: 'almost', answerGiven: 'leó', now: NOW });
		expect((await historyOf('i1')).at(-1)?.grade).toBe(Grade.Hard);

		store = await makeTestStore();
		setStoreForTesting(store);
		seed('i1');
		await applyResult(single, { verdict: 'wrong', answerGiven: 'como', now: NOW });
		expect((await historyOf('i1')).at(-1)?.grade).toBe(Grade.Again);
	});

	it('returns each reviewed item as it was before the review', async () => {
		seed('i1');
		const before = await cardOf('i1');

		const priors = await applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });

		expect(priors.get('i1')).toEqual(before);
		// The snapshot is of the *old* card; the derived one has moved on.
		expect(await cardOf('i1')).not.toEqual(before);
	});

	it('hands back a fresh card for an item that has never been reviewed', async () => {
		seed('i1');

		const priors = await applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });

		// The mock this replaces could return `null` here, because a card was a
		// stored column that might be unset. A derived card cannot be unset: an
		// empty history folds to a new card at the item's `introducedAt`.
		expect(priors.get('i1')).toEqual(newCardState(NOW));
	});

	it('omits items that no longer exist, and returns nothing for match-pairs', async () => {
		seed('i1');

		const priors = await applyResult(
			{ ...cloze, itemIds: ['i1', 'gone'] },
			{ verdict: 'correct', answerGiven: 'leo', now: NOW }
		);
		expect([...priors.keys()]).toEqual(['i1']);

		const none = await applyResult(match, { verdict: 'correct', answerGiven: '', now: NOW });
		expect(none.size).toBe(0);
	});
});

describe('amendResult', () => {
	/** Plays a correct answer through `applyResult`, as the session would. */
	async function answeredCorrectly(): Promise<{
		prior: FsrsCardState;
		priors: Map<string, FsrsCardState | null>;
	}> {
		seed('i1');
		const prior = (await cardOf('i1')) as FsrsCardState;
		const priors = await applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });
		return { prior, priors };
	}

	it('rewrites the review instead of stacking a second one', async () => {
		const { prior, priors } = await answeredCorrectly();
		expect(await historyOf('i1')).toHaveLength(1);

		await amendResult(single, Grade.Easy, priors, NOW);

		expect(await historyOf('i1')).toEqual([{ at: NOW, grade: Grade.Easy }]);
		// The card follows the rewritten history, which lands in the same place
		// the old "recompute from the captured prior" arithmetic did.
		expect(await cardOf('i1')).toEqual(reviewCard(prior, Grade.Easy, NOW));
	});

	it('amending twice equals amending once with the last grade', async () => {
		const { prior, priors } = await answeredCorrectly();

		await amendResult(single, Grade.Easy, priors, NOW);
		await amendResult(single, Grade.Hard, priors, NOW);

		expect(await historyOf('i1')).toEqual([{ at: NOW, grade: Grade.Hard }]);
		expect(await cardOf('i1')).toEqual(reviewCard(prior, Grade.Hard, NOW));
	});

	it('leaves items the review skipped, and match-pairs rounds, untouched', async () => {
		const { priors } = await answeredCorrectly();
		// Present on the challenge but absent from the priors: never reviewed.
		seed('i2');

		await amendResult({ ...cloze, itemIds: ['i1', 'i2'] }, Grade.Easy, priors, NOW);
		expect(await historyOf('i2')).toEqual([]);

		await amendResult(match, Grade.Easy, priors, NOW);
		expect(await historyOf('i1')).toHaveLength(1);
	});
});

describe('applyOverturn', () => {
	it('writes one Good review per item on the challenge', async () => {
		seed('i1');
		seed('i2');

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
		seed('i1');
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

	it('skips items that no longer exist, and match-pairs rounds entirely', async () => {
		seed('i1');

		await applyOverturn({ ...cloze, itemIds: ['i1', 'gone'] }, NOW);
		expect(await historyOf('i1')).toHaveLength(1);
		expect(await getItem('gone')).toBeUndefined();

		await applyOverturn(match, NOW);
		// Still just the one review from the cloze above.
		expect(await historyOf('i1')).toHaveLength(1);
	});
});
