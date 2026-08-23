/**
 * The database-touching engine functions worth a test, because each one decides
 * what happens to a learner's SRS card and getting any of them wrong corrupts
 * scheduling silently: `applyResult` (the grade, and the pre-review snapshot it
 * hands back), `amendResult` (the learner re-rated a correct answer) and
 * `applyOverturn` (a dispute was won).
 *
 * IndexedDB does not exist in the node test environment, so `$lib/db` is
 * replaced with an in-memory stand-in here — which is also why this lives in
 * its own file rather than in `engine.test.ts`, whose subject is the pure half
 * and which must keep talking to the real module graph.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Grade, newCardState, reviewCard } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import type { Challenge, KnowledgeItem } from '$lib/types';

const NOW = 1_700_000_000_000;

/** The fake item table `$lib/db` is mocked onto. */
const items = new Map<string, KnowledgeItem>();

vi.mock('$lib/db', () => ({
	getItem: async (id: string) => items.get(id),
	updateItemAfterReview: async (
		id: string,
		fsrsCard: unknown,
		entry: { at: number; grade: number },
		opts: { replaceLast?: boolean } = {}
	) => {
		const item = items.get(id);
		if (!item) return false;
		const history =
			opts.replaceLast && item.history.length > 0
				? [...item.history.slice(0, -1), entry]
				: [...item.history, entry];
		items.set(id, { ...item, fsrsCard, history });
		return true;
	},
	// Imported by engine.ts at module load; never called from this test.
	addResult: async () => undefined,
	addXp: async () => undefined,
	enqueueChallenges: async () => undefined,
	getAllItems: async () => [...items.values()],
	getChallengesByIds: async () => [],
	markChallengeDone: async () => undefined,
	queuedCount: async () => 0,
	recentResults: async () => [],
	upsertItems: async () => undefined
}));

const { amendResult, applyOverturn, applyResult } = await import('./engine');

function seed(id: string): KnowledgeItem {
	const item: KnowledgeItem = {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		fsrsCard: newCardState(NOW),
		introducedAt: NOW,
		history: []
	};
	items.set(id, item);
	return item;
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
	beforeEach(() => items.clear());

	/** The grade written for a fast, correct answer to `challenge`. */
	async function gradeFor(challenge: Challenge): Promise<number | undefined> {
		items.clear();
		seed('i1');
		await applyResult(challenge, {
			verdict: 'correct',
			answerGiven: 'leo',
			responseMs: 200,
			now: NOW
		});
		return items.get('i1')?.history.at(-1)?.grade;
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
		expect(items.get('i1')?.history.at(-1)?.grade).toBe(Grade.Hard);

		items.clear();
		seed('i1');
		await applyResult(single, { verdict: 'wrong', answerGiven: 'como', now: NOW });
		expect(items.get('i1')?.history.at(-1)?.grade).toBe(Grade.Again);
	});

	it('returns each reviewed item as it was before the review', async () => {
		const before = seed('i1').fsrsCard as FsrsCardState;

		const priors = await applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });

		expect(priors.get('i1')).toEqual(before);
		// The snapshot is of the *old* card; the stored one has moved on.
		expect(items.get('i1')?.fsrsCard).not.toEqual(before);
	});

	it('returns null for an item that had no card yet', async () => {
		items.set('i1', { ...seed('i1'), fsrsCard: null });

		const priors = await applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });

		expect(priors.has('i1')).toBe(true);
		expect(priors.get('i1')).toBeNull();
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
	beforeEach(() => items.clear());

	/** Plays a correct answer through `applyResult`, as the session would. */
	async function answeredCorrectly(): Promise<{
		prior: FsrsCardState;
		priors: Map<string, FsrsCardState | null>;
	}> {
		const prior = seed('i1').fsrsCard as FsrsCardState;
		const priors = await applyResult(single, { verdict: 'correct', answerGiven: 'leo', now: NOW });
		return { prior, priors };
	}

	it('rewrites the review instead of stacking a second one', async () => {
		const { prior, priors } = await answeredCorrectly();
		expect(items.get('i1')?.history).toHaveLength(1);

		await amendResult(single, Grade.Easy, priors, NOW);

		expect(items.get('i1')?.history).toEqual([{ at: NOW, grade: Grade.Easy }]);
		// Recomputed from the captured prior — not nudged from where Good left it.
		expect(items.get('i1')?.fsrsCard).toEqual(reviewCard(prior, Grade.Easy, NOW));
	});

	it('amending twice equals amending once with the last grade', async () => {
		const { prior, priors } = await answeredCorrectly();

		await amendResult(single, Grade.Easy, priors, NOW);
		await amendResult(single, Grade.Hard, priors, NOW);

		expect(items.get('i1')?.history).toEqual([{ at: NOW, grade: Grade.Hard }]);
		expect(items.get('i1')?.fsrsCard).toEqual(reviewCard(prior, Grade.Hard, NOW));
	});

	it('leaves items the review skipped, and match-pairs rounds, untouched', async () => {
		const { priors } = await answeredCorrectly();
		// Present on the challenge but absent from the priors: never reviewed.
		seed('i2');

		await amendResult({ ...cloze, itemIds: ['i1', 'i2'] }, Grade.Easy, priors, NOW);
		expect(items.get('i2')?.history).toEqual([]);

		await amendResult(match, Grade.Easy, priors, NOW);
		expect(items.get('i1')?.history).toHaveLength(1);
	});
});

describe('applyOverturn', () => {
	beforeEach(() => items.clear());

	it('writes one Good review per item on the challenge', async () => {
		seed('i1');
		seed('i2');

		await applyOverturn(cloze, NOW);

		for (const id of ['i1', 'i2']) {
			const item = items.get(id);
			expect(item?.history).toEqual([{ at: NOW, grade: Grade.Good }]);
			// A Good review schedules the card into the future.
			expect((item?.fsrsCard as FsrsCardState).due).toBeGreaterThan(NOW);
			expect((item?.fsrsCard as FsrsCardState).reps).toBe(1);
		}
	});

	it('stacks on top of the Again review the wrong answer already wrote', async () => {
		const item = seed('i1');
		// What `applyResult` leaves behind for a wrong answer.
		items.set('i1', {
			...item,
			history: [{ at: NOW - 1000, grade: Grade.Again }]
		});

		await applyOverturn({ ...cloze, itemIds: ['i1'] }, NOW);

		// The lapse is not rewritten — the compensating review is appended to it.
		expect(items.get('i1')?.history).toEqual([
			{ at: NOW - 1000, grade: Grade.Again },
			{ at: NOW, grade: Grade.Good }
		]);
	});

	it('skips items that no longer exist, and match-pairs rounds entirely', async () => {
		seed('i1');

		await applyOverturn({ ...cloze, itemIds: ['i1', 'gone'] }, NOW);
		expect(items.get('i1')?.history).toHaveLength(1);
		expect(items.has('gone')).toBe(false);

		await applyOverturn(match, NOW);
		// Still just the one review from the cloze above.
		expect(items.get('i1')?.history).toHaveLength(1);
	});
});
