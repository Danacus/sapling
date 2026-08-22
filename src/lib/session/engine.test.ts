/**
 * Unit tests for the pure half of the session engine.
 *
 * The database-touching half (`applyResult`, `runRefillIfNeeded`,
 * `bankSessionXp`) needs IndexedDB, which node does not have, so it is covered
 * by the same "thin wrapper, no logic" rule as `src/lib/db/repositories.ts`:
 * everything worth asserting was pushed down into `planRefill` / `xpFor` /
 * `sessionSummary`, which are exercised here.
 *
 * The one exception is {@link planRefill}'s output being fed to the real
 * `getBatch` in mock mode (no API key in node ⇒ mock automatically), which
 * smoke-tests the whole generate → resolve path against a real plan.
 */

import { describe, expect, it } from 'vitest';

import { getBatch, isMockMode, makeMatchPairsChallenge } from '$lib/llm';
import type { ProgressStep } from '$lib/llm';
import { gradeFromResult, newCardState, reviewCard, Grade } from '$lib/srs';
import type { Challenge, ChallengeResult, KnowledgeItem, Profile, Verdict } from '$lib/types';
import {
	BATCH_TARGET,
	COMBO_THRESHOLD,
	MATCH_PAIRS_EVERY,
	MATCH_PAIRS_XP,
	MAX_COMBO_BONUS,
	MAX_RECENT_MISTAKES,
	SESSION_LENGTH,
	SKIP_ANSWER,
	comboAfter,
	dedupeNewItems,
	deriveRecentMistakes,
	planRefill,
	remapItemIds,
	sessionSummary,
	wantsMatchRound,
	xpFor,
	type SessionAnswer
} from './engine';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function profile(overrides: Partial<Profile> = {}): Profile {
	return {
		nativeLanguage: 'English',
		targetLanguage: 'Spanish',
		level: 'beginner',
		interests: ['cooking', 'football'],
		dailyGoalXp: 50,
		model: 'google/gemini-2.5-flash-lite',
		createdAt: NOW - 30 * DAY,
		...overrides
	};
}

/** An item whose card is due `dueOffset` ms from `NOW` (negative = overdue). */
function item(id: string, dueOffset: number, history: KnowledgeItem['history'] = []): KnowledgeItem {
	const card = newCardState(NOW);
	return {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		fsrsCard: { ...card, due: NOW + dueOffset },
		introducedAt: NOW - 10 * DAY,
		history
	};
}

/* -------------------------------------------------------------------------- */

describe('xpFor', () => {
	it('pays the base rate below the combo threshold', () => {
		expect(xpFor('correct', 0)).toBe(10);
		expect(xpFor('correct', 1)).toBe(10);
		expect(xpFor('correct', COMBO_THRESHOLD - 1)).toBe(10);
		expect(xpFor('almost', 2)).toBe(8);
	});

	it('pays nothing for a wrong answer, whatever the combo', () => {
		expect(xpFor('wrong', 0)).toBe(0);
		expect(xpFor('wrong', 9)).toBe(0);
	});

	it('adds a growing combo bonus from the threshold onwards', () => {
		expect(xpFor('correct', 3)).toBe(12);
		expect(xpFor('correct', 4)).toBe(14);
		expect(xpFor('almost', 3)).toBe(10);
		expect(xpFor('almost', 5)).toBe(14);
	});

	it('caps the combo bonus', () => {
		expect(xpFor('correct', 7)).toBe(10 + MAX_COMBO_BONUS);
		expect(xpFor('correct', 40)).toBe(10 + MAX_COMBO_BONUS);
		expect(xpFor('almost', 40)).toBe(8 + MAX_COMBO_BONUS);
	});

	it('never awards more than base + cap', () => {
		for (let combo = 0; combo < 50; combo++) {
			expect(xpFor('correct', combo)).toBeLessThanOrEqual(10 + MAX_COMBO_BONUS);
		}
	});
});

describe('comboAfter', () => {
	it('extends on correct and almost, breaks on wrong', () => {
		expect(comboAfter('correct', 0)).toBe(1);
		expect(comboAfter('almost', 4)).toBe(5);
		expect(comboAfter('wrong', 9)).toBe(0);
	});
});

describe('wantsMatchRound', () => {
	it('fires after every Nth answered challenge', () => {
		expect(wantsMatchRound(0, -1)).toBe(false);
		expect(wantsMatchRound(MATCH_PAIRS_EVERY - 1, -1)).toBe(false);
		expect(wantsMatchRound(MATCH_PAIRS_EVERY, -1)).toBe(true);
		expect(wantsMatchRound(2 * MATCH_PAIRS_EVERY, MATCH_PAIRS_EVERY)).toBe(true);
	});

	it('does not repeat itself at the same count', () => {
		expect(wantsMatchRound(MATCH_PAIRS_EVERY, MATCH_PAIRS_EVERY)).toBe(false);
	});
});

describe('sessionSummary', () => {
	const answers: SessionAnswer[] = [
		{ challengeId: 'a', type: 'multiple-choice', verdict: 'correct', xp: 10, itemIds: ['i1'] },
		{ challengeId: 'b', type: 'cloze', verdict: 'almost', xp: 8, itemIds: ['i1', 'i2'] },
		{ challengeId: 'c', type: 'typed-translation', verdict: 'wrong', xp: 0, itemIds: ['i3'] },
		{ challengeId: 'd', type: 'match-pairs', verdict: 'correct', xp: 5, itemIds: [] }
	];

	it('totals xp and verdicts', () => {
		const summary = sessionSummary(answers);
		expect(summary.answered).toBe(4);
		expect(summary.correct).toBe(2);
		expect(summary.almost).toBe(1);
		expect(summary.wrong).toBe(1);
		expect(summary.xp).toBe(23);
	});

	it('counts almost as accepted and de-duplicates practised items', () => {
		const summary = sessionSummary(answers);
		expect(summary.accuracy).toBeCloseTo(3 / 4);
		expect(summary.itemsPracticed).toBe(3);
	});

	it('is safe on an empty session', () => {
		expect(sessionSummary([])).toEqual({
			answered: 0,
			correct: 0,
			almost: 0,
			wrong: 0,
			xp: 0,
			accuracy: 0,
			itemsPracticed: 0
		});
	});
});

/* -------------------------------------------------------------------------- */

describe('planRefill', () => {
	it('produces getBatch args from an empty collection', () => {
		const plan = planRefill([], profile(), NOW);

		expect(plan.reviewItems).toEqual([]);
		expect(plan.recentAccuracy).toBeUndefined();
		// Unknown accuracy ⇒ the SRS base rate of 3 new words.
		expect(plan.newItemSlots).toBe(3);
		expect(plan.args).toEqual({
			profile: {
				nativeLanguage: 'English',
				targetLanguage: 'Spanish',
				level: 'beginner',
				interests: ['cooking', 'football']
			},
			reviewItems: [],
			newItemSlots: 3,
			count: BATCH_TARGET
		});
	});

	it('carries only the profile fields the prompt needs', () => {
		const plan = planRefill([], profile(), NOW);
		expect(Object.keys(plan.args.profile).sort()).toEqual([
			'interests',
			'level',
			'nativeLanguage',
			'targetLanguage'
		]);
		expect(plan.args.profile).not.toHaveProperty('model');
		expect(plan.args.profile).not.toHaveProperty('dailyGoalXp');
	});

	it('sends due items as {id, term, meaning}, most overdue first', () => {
		const items = [item('a', -1 * DAY), item('b', -5 * DAY), item('c', +2 * DAY)];
		const plan = planRefill(items, profile(), NOW);

		expect(plan.args.reviewItems).toEqual([
			{ id: 'b', term: 'term-b', meaning: 'meaning-b' },
			{ id: 'a', term: 'term-a', meaning: 'meaning-a' }
		]);
	});

	it('paces new words off recent accuracy', () => {
		const strong = [
			item('a', -DAY, [
				{ at: NOW - DAY, grade: Grade.Good },
				{ at: NOW - DAY, grade: Grade.Easy }
			])
		];
		const weak = [
			item('a', -DAY, [
				{ at: NOW - DAY, grade: Grade.Again },
				{ at: NOW - DAY, grade: Grade.Again },
				{ at: NOW - DAY, grade: Grade.Good }
			])
		];

		expect(planRefill(strong, profile(), NOW).recentAccuracy).toBe(1);
		expect(planRefill(strong, profile(), NOW).newItemSlots).toBe(5);
		expect(planRefill(weak, profile(), NOW).newItemSlots).toBe(1);
	});

	it('honours maxItems, count and recentMistakes overrides', () => {
		const items = [item('a', -3 * DAY), item('b', -2 * DAY), item('c', -DAY)];
		const plan = planRefill(items, profile(), NOW, {
			maxItems: 2,
			count: 6,
			recentMistakes: [{ term: 'temprano', gave: 'tarde' }]
		});

		expect(plan.args.reviewItems).toHaveLength(2);
		expect(plan.args.count).toBe(6);
		expect(plan.args.recentMistakes).toEqual([{ term: 'temprano', gave: 'tarde' }]);
	});

	it('omits recentMistakes entirely when there are none', () => {
		expect(planRefill([], profile(), NOW, { recentMistakes: [] }).args).not.toHaveProperty(
			'recentMistakes'
		);
	});

	it('includes a trimmed topic in the batch args when one is given', () => {
		const plan = planRefill([], profile(), NOW, { topic: '  ordering in a restaurant  ' });
		expect(plan.args.topic).toBe('ordering in a restaurant');
	});

	it('omits topic entirely when absent or blank', () => {
		expect(planRefill([], profile(), NOW).args).not.toHaveProperty('topic');
		expect(planRefill([], profile(), NOW, { topic: '   ' }).args).not.toHaveProperty('topic');
		expect(planRefill([], profile(), NOW, { topic: '' }).args).not.toHaveProperty('topic');
	});

	it('is pure: it does not mutate the items it is given', () => {
		const items = [item('a', -DAY), item('b', +DAY)];
		const snapshot = structuredClone(items);
		planRefill(items, profile(), NOW);
		expect(items).toEqual(snapshot);
	});

	it('reacts to a card that was just reviewed (no longer due)', () => {
		const reviewed = item('a', -DAY);
		const plan = planRefill(
			[{ ...reviewed, fsrsCard: reviewCard(reviewed.fsrsCard as never, Grade.Easy, NOW) }],
			profile(),
			NOW
		);
		expect(plan.args.reviewItems).toEqual([]);
	});
});

/* -------------------------------------------------------------------------- */

describe('deriveRecentMistakes', () => {
	/** A typed-translation challenge exercising `itemIds`. */
	function challenge(id: string, itemIds: string[]): Challenge {
		return {
			id,
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'p',
			acceptedAnswers: ['a'],
			itemIds
		};
	}

	function result(challengeId: string, verdict: Verdict, answerGiven: string): ChallengeResult {
		return { challengeId, verdict, answerGiven, at: NOW };
	}

	const items = [item('a', -DAY), item('b', -DAY), item('c', -DAY)];

	it('resolves a wrong result back to the term it exercised', () => {
		const mistakes = deriveRecentMistakes(
			[result('c1', 'wrong', 'lees')],
			[challenge('c1', ['a'])],
			items
		);
		expect(mistakes).toEqual([{ term: 'term-a', gave: 'lees' }]);
	});

	it('carries a skip through as its own kind of mistake', () => {
		const mistakes = deriveRecentMistakes(
			[result('c1', 'wrong', SKIP_ANSWER)],
			[challenge('c1', ['a'])],
			items
		);
		expect(mistakes).toEqual([{ term: 'term-a', gave: '(skipped)' }]);
	});

	it('ignores accepted answers and match-pairs rounds', () => {
		const match: Challenge = {
			id: 'm1',
			type: 'match-pairs',
			direction: 'toNative',
			pairs: [{ a: 'term-a', b: 'meaning-a' }],
			itemIds: ['a']
		};
		const mistakes = deriveRecentMistakes(
			[
				result('c1', 'correct', 'leo'),
				result('c2', 'almost', 'leo'),
				result('m1', 'wrong', 'x')
			],
			[challenge('c1', ['a']), challenge('c2', ['b']), match],
			items
		);
		expect(mistakes).toEqual([]);
	});

	it('skips silently when the challenge row or the item is gone', () => {
		const mistakes = deriveRecentMistakes(
			[result('vanished', 'wrong', 'x'), result('c1', 'wrong', 'y')],
			[challenge('c1', ['deleted-item'])],
			items
		);
		expect(mistakes).toEqual([]);
	});

	it('keeps only the most recent entry per term and caps the list', () => {
		const results = [
			result('c1', 'wrong', 'newest'),
			result('c2', 'wrong', 'older') // same item
		];
		const mistakes = deriveRecentMistakes(
			results,
			[challenge('c1', ['a']), challenge('c2', ['a'])],
			items
		);
		expect(mistakes).toEqual([{ term: 'term-a', gave: 'newest' }]);

		const many = Array.from({ length: 20 }, (_, i) => result(`c${i}`, 'wrong', `g${i}`));
		const manyChallenges = Array.from({ length: 20 }, (_, i) =>
			challenge(`c${i}`, [`i${i}`])
		);
		const manyItems = Array.from({ length: 20 }, (_, i) => item(`i${i}`, -DAY));
		expect(deriveRecentMistakes(many, manyChallenges, manyItems)).toHaveLength(
			MAX_RECENT_MISTAKES
		);
	});

	it('labels a blank answer rather than sending an empty string', () => {
		const mistakes = deriveRecentMistakes(
			[result('c1', 'wrong', '   ')],
			[challenge('c1', ['a'])],
			items
		);
		expect(mistakes).toEqual([{ term: 'term-a', gave: '(no answer)' }]);
	});
});

describe('planRefill difficulty feedback', () => {
	function challenge(id: string, itemIds: string[]): Challenge {
		return {
			id,
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'p',
			acceptedAnswers: ['a'],
			itemIds
		};
	}

	it('derives recentMistakes from the result log and the challenges behind it', () => {
		const items = [item('a', -DAY), item('b', -DAY)];
		const plan = planRefill(items, profile(), NOW, {
			recentResults: [
				{ challengeId: 'c1', verdict: 'wrong', answerGiven: SKIP_ANSWER, at: NOW - 1000 },
				{ challengeId: 'c2', verdict: 'wrong', answerGiven: 'tarde', at: NOW - 2000 }
			],
			recentChallenges: [challenge('c1', ['a']), challenge('c2', ['b'])]
		});

		expect(plan.args.recentMistakes).toEqual([
			{ term: 'term-a', gave: '(skipped)' },
			{ term: 'term-b', gave: 'tarde' }
		]);
	});

	it('reports recent accuracy to the prompt, rounded to two decimals', () => {
		const history = [
			{ at: NOW - DAY, grade: Grade.Good },
			{ at: NOW - DAY, grade: Grade.Again },
			{ at: NOW - DAY, grade: Grade.Again }
		];
		const plan = planRefill([item('a', -DAY, history)], profile(), NOW);

		expect(plan.recentAccuracy).toBeCloseTo(1 / 3);
		expect(plan.args.recentAccuracy).toBe(0.33);
	});

	it('omits recentAccuracy on day one, when there is no history', () => {
		expect(planRefill([], profile(), NOW).args).not.toHaveProperty('recentAccuracy');
	});
});

describe('a skipped challenge', () => {
	it('is worth nothing, breaks the combo and grades FSRS Again', () => {
		expect(xpFor('wrong', 5)).toBe(0);
		expect(comboAfter('wrong', 5)).toBe(0);
		// Whatever the response time, a skip is "I could not produce it".
		expect(gradeFromResult('wrong', 200)).toBe(Grade.Again);
		expect(gradeFromResult('wrong')).toBe(Grade.Again);
	});

	it('counts as a wrong answer in the session summary', () => {
		const summary = sessionSummary([
			{ challengeId: 'a', type: 'cloze', verdict: 'correct', xp: 10, itemIds: ['i1'] },
			{ challengeId: 'b', type: 'cloze', verdict: 'wrong', xp: 0, itemIds: ['i2'] }
		]);
		expect(summary.wrong).toBe(1);
		expect(summary.accuracy).toBe(0.5);
	});
});

describe('dedupeNewItems', () => {
	it('drops a proposed item whose term matches an existing one case/whitespace-insensitively, and remaps its id', () => {
		const existing = item('e1', -DAY);
		const proposed: KnowledgeItem = { ...item('new1', 0), term: '  Term-E1  ' };

		const { newItems, idRemap } = dedupeNewItems([existing], [proposed]);

		expect(newItems).toEqual([]);
		expect(idRemap.get('new1')).toBe('e1');
	});

	it('keeps a genuinely new item and leaves the remap empty', () => {
		const existing = item('e1', -DAY);
		const proposed = item('new1', 0);

		const { newItems, idRemap } = dedupeNewItems([existing], [proposed]);

		expect(newItems).toEqual([proposed]);
		expect(idRemap.size).toBe(0);
	});

	it('is pure: it does not mutate either list it is given', () => {
		const existing = [item('e1', -DAY)];
		const proposed = [item('new1', 0), { ...item('new2', 0), term: 'Term-E1' }];
		const existingSnapshot = structuredClone(existing);
		const proposedSnapshot = structuredClone(proposed);

		dedupeNewItems(existing, proposed);

		expect(existing).toEqual(existingSnapshot);
		expect(proposed).toEqual(proposedSnapshot);
	});
});

describe('remapItemIds', () => {
	function challenge(id: string, itemIds: string[]): Challenge {
		return {
			id,
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'p',
			acceptedAnswers: ['a'],
			itemIds
		};
	}

	it('rewrites itemIds through the remap, leaving unmapped ids untouched', () => {
		const idRemap = new Map([['dup', 'real']]);
		const challenges = [challenge('c1', ['dup', 'other'])];

		const remapped = remapItemIds(challenges, idRemap);

		expect(remapped[0].itemIds).toEqual(['real', 'other']);
	});

	it('is a no-op (same array) when the remap is empty', () => {
		const challenges = [challenge('c1', ['x'])];
		expect(remapItemIds(challenges, new Map())).toBe(challenges);
	});
});

describe('planRefill → getBatch (mock mode)', () => {
	it('runs in mock mode under node (no API key)', () => {
		expect(isMockMode()).toBe(true);
	});

	it('produces a playable batch whose new items need card initialization', async () => {
		const items = [item('a', -2 * DAY), item('b', -DAY)];
		const plan = planRefill(items, profile(), NOW);
		const batch = await getBatch(plan.args);

		expect(batch.challenges.length).toBeGreaterThanOrEqual(5);
		expect(batch.newItems.length).toBeGreaterThan(0);

		// The contract the engine exists to honour: the LLM layer never sets a
		// card, so `runRefillIfNeeded` must fill one in before persisting.
		for (const newItem of batch.newItems) {
			expect(newItem.fsrsCard).toBeNull();
		}

		// Every challenge references a real id: either a review item we sent or
		// one of the freshly minted new items.
		const known = new Set([...items.map((i) => i.id), ...batch.newItems.map((i) => i.id)]);
		for (const challenge of batch.challenges) {
			expect(challenge.itemIds.length).toBeGreaterThan(0);
			for (const id of challenge.itemIds) expect(known.has(id)).toBe(true);
		}

		// Mock mode spends nothing.
		expect(batch.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
	});

	it('walks the same progress steps as the real path, instantly', async () => {
		const steps: ProgressStep[] = [];
		await getBatch(planRefill([], profile(), NOW).args, { onProgress: (s) => steps.push(s) });
		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
	});

	it('covers every gradeable challenge type the session renders', async () => {
		const plan = planRefill([], profile(), NOW);
		const batch = await getBatch(plan.args);
		const types = new Set(batch.challenges.map((c) => c.type));

		expect(types.has('multiple-choice')).toBe(true);
		expect(types.has('cloze')).toBe(true);
		expect(types.has('typed-translation')).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

/**
 * A dry run of the loop `src/routes/learn/+page.svelte` drives, with the
 * database swapped for an array and the learner swapped for a scripted answer
 * function. It exercises the parts that are easy to get subtly wrong — combo
 * accounting, where the free match rounds land, and what each answer is worth —
 * against a real mock batch.
 */
describe('session walkthrough (mock batch, no database)', () => {
	/** Plays a session the way the page does; `answerAs` scripts the learner. */
	async function playSession(
		known: KnowledgeItem[],
		answerAs: (challenge: Challenge, index: number) => Verdict
	) {
		const plan = planRefill(known, profile(), NOW);
		const batch = await getBatch(plan.args);

		// What `runRefillIfNeeded` does before anything is persisted.
		const newItems = batch.newItems.map((i) => ({ ...i, fsrsCard: newCardState(NOW) }));
		const pool = [...known, ...newItems];
		const queue = [...batch.challenges];

		const answers: SessionAnswer[] = [];
		let combo = 0;
		let llmAnswered = 0;
		let lastMatchAfter = -1;
		let matchRounds = 0;

		for (;;) {
			if (llmAnswered >= SESSION_LENGTH) break;

			let challenge: Challenge | undefined;
			if (pool.length >= 4 && wantsMatchRound(llmAnswered, lastMatchAfter)) {
				challenge = makeMatchPairsChallenge(pool);
				if (challenge) {
					lastMatchAfter = llmAnswered;
					matchRounds++;
				}
			}
			if (!challenge) {
				challenge = queue.shift();
				if (!challenge) break;
			}

			const isMatch = challenge.type === 'match-pairs';
			const verdict = isMatch ? 'correct' : answerAs(challenge, llmAnswered);
			const nextCombo = isMatch ? combo : comboAfter(verdict, combo);
			const xp = isMatch ? MATCH_PAIRS_XP : xpFor(verdict, nextCombo);

			combo = nextCombo;
			if (!isMatch) llmAnswered++;
			answers.push({
				challengeId: challenge.id,
				type: challenge.type,
				verdict,
				xp,
				itemIds: isMatch ? [] : challenge.itemIds
			});
		}

		return { answers, matchRounds, llmAnswered, summary: sessionSummary(answers), queue };
	}

	it('plays a flawless session: 12 answers, 2 free rounds, capped combo', async () => {
		const known = Array.from({ length: 6 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, () => 'correct');

		expect(run.llmAnswered).toBe(SESSION_LENGTH);
		expect(run.matchRounds).toBe(2); // after the 4th and the 8th answer
		expect(run.answers).toHaveLength(SESSION_LENGTH + 2);
		expect(run.summary.accuracy).toBe(1);

		// Combos 1-2 pay the flat 10; from combo 3 the bonus ramps 2,4,6,8,10
		// (12,14,16,18,20) and every combo from 7 on is capped at 20.
		const expectedLlmXp = 10 * 2 + (12 + 14 + 16 + 18 + 20) + 20 * 5;
		expect(run.summary.xp).toBe(expectedLlmXp + 2 * MATCH_PAIRS_XP);
	});

	it('a wrong answer resets the combo back to the base rate', async () => {
		const known = Array.from({ length: 6 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, (_challenge, index) =>
			index === 4 ? 'wrong' : 'correct'
		);

		const llmAnswers = run.answers.filter((a) => a.type !== 'match-pairs');
		expect(llmAnswers[3].xp).toBe(14); // combo 4
		expect(llmAnswers[4].xp).toBe(0); // the miss
		expect(llmAnswers[5].xp).toBe(10); // combo restarted at 1
		expect(run.summary.wrong).toBe(1);
	});

	it('ends gracefully when the queue runs dry before 12 answers', async () => {
		// A tiny batch: mock mode still returns its five canned challenges.
		const plan = planRefill([], profile(), NOW, { count: 5 });
		const batch = await getBatch(plan.args);
		expect(batch.challenges.length).toBeLessThan(SESSION_LENGTH);

		const run = await playSession([], () => 'correct');
		expect(run.llmAnswered).toBeLessThanOrEqual(SESSION_LENGTH);
		expect(run.queue).toHaveLength(0);
	});

	it('match rounds carry no item ids into the summary', async () => {
		const known = Array.from({ length: 6 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, () => 'correct');

		for (const answer of run.answers) {
			if (answer.type === 'match-pairs') expect(answer.itemIds).toEqual([]);
			else expect(answer.itemIds.length).toBeGreaterThan(0);
		}
	});
});
