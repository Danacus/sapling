/**
 * Unit tests for the session engine's pure half, through the wasm core.
 *
 * The planners are Rust's and tested there (`crates/sapling-challenges`'
 * `session.rs` and `topup.rs`); what is left here is the seam — positions
 * mapped back to the stored rows, the batch arguments built around the
 * wants — plus the session accounting, and a mock top-up played end to end.
 * The database-touching half (`applyResult`, `generateChallenges`,
 * `startSession`) is a thin wrapper, like `src/lib/db/repositories.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { ChallengeRow } from '$lib/db';
import { challengeOf } from '$lib/db';
import { loadWasmCore } from '$lib/db/backend.testing';
import { getBatch, isMockMode } from '$lib/llm';
import type { ProgressStep } from '$lib/llm';
import { gradeFromResult, Grade } from '$lib/srs';
import type {
	Challenge,
	ClozeChallenge,
	KnowledgeItem,
	MultipleChoiceChallenge,
	Profile,
	TypedTranslationChallenge,
	Verdict,
	WordOrderChallenge
} from '$lib/types';
import {
	SESSION_LENGTH,
	interleaveMatchRounds,
	planRefill,
	planSession,
	sessionSummary,
	spokenAnswerFor,
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
		model: 'google/gemini-2.5-flash-lite',
		createdAt: NOW - 30 * DAY,
		...overrides
	};
}

/**
 * An item due `dueOffset` ms from `NOW` (negative = overdue), at strength 0 —
 * a word FSRS has no curve for yet, so it reads the new-word memory and the
 * starting skill.
 */
function item(
	id: string,
	dueOffset: number,
	history: KnowledgeItem['history'] = []
): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		fsrsCard: null,
		srs: { due: NOW + dueOffset, retrievability: 0, strength: 0 },
		introducedAt: NOW - 10 * DAY,
		history
	};
}

/** The same word at a given strength, remembered for certain — display, and early or not for match rounds. */
function atStrength(word: KnowledgeItem, strength: number): KnowledgeItem {
	return { ...word, srs: { ...word.srs!, retrievability: 1, strength } };
}

/** A pooled challenge; defaults to freshly generated and never served. */
function row(id: string, itemIds: string[], over: Partial<ChallengeRow> = {}): ChallengeRow {
	return {
		id,
		type: 'multiple-choice',
		direction: 'toNative',
		prompt: `prompt-${id}`,
		options: ['a', 'b', 'c', 'd'],
		correctIndex: 0,
		itemIds,
		generatedAt: NOW - DAY,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...over
	} as ChallengeRow;
}

/** A bankless cloze: typed, the hardest thing in the pool. */
function freeProductionRow(
	id: string,
	itemIds: string[],
	over: Partial<ChallengeRow> = {}
): ChallengeRow {
	return {
		id,
		type: 'cloze',
		direction: 'toTarget',
		sentence: 'Yo ___ ayer.',
		acceptedAnswers: ['corrí'],
		itemIds,
		generatedAt: NOW - DAY,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...over
	} as ChallengeRow;
}

/**
 * A pooled one-word recognition row: the easiest thing in the pool, which a
 * brand-new word fits, where {@link freeProductionRow}'s typed cloze fits none
 * of the fresh cards {@link item} builds.
 */
function recognition(
	id: string,
	itemIds: string[],
	over: Partial<ChallengeRow> = {}
): ChallengeRow {
	return {
		id,
		type: 'multiple-choice',
		direction: 'toNative',
		prompt: `prompt-${id}`,
		options: ['a', 'b', 'c', 'd'],
		correctIndex: 0,
		itemIds,
		generatedAt: NOW - DAY,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...over
	} as ChallengeRow;
}

/**
 * A word with a full strength bar, remembered for certain. Its skill is still
 * the model's starting one: strength is display and decides nothing served.
 */
function strongItem(id: string, dueOffset: number): KnowledgeItem {
	return atStrength(item(id, dueOffset), 0.9);
}

const ids = (challenges: Challenge[]) => challenges.map((challenge) => challenge.id);

/* -------------------------------------------------------------------------- */

describe('interleaveMatchRounds', () => {
	const generated = (n: number): Challenge[] =>
		Array.from({ length: n }, (_, i) => challengeOf(row(`c${i}`, ['k0'])));
	const known = (n: number) => Array.from({ length: n }, (_, i) => item(`k${i}`, -DAY));

	it('keeps the plan in order with a round after every fourth early challenge, never last', () => {
		const plan = generated(9);
		const queue = interleaveMatchRounds(plan, known(6), 1);

		expect(queue.map((challenge) => challenge.type === 'match-pairs')).toEqual([
			false,
			false,
			false,
			false,
			true,
			false,
			false,
			false,
			false,
			true,
			false
		]);
		expect(queue.filter((challenge) => challenge.type !== 'match-pairs')).toEqual(plan);
		expect(interleaveMatchRounds(plan, known(6), 1)).toEqual(queue);
	});
});

describe('spokenAnswerFor', () => {
	// The banner speaks this and the session screen pre-synthesizes it; these
	// pin that both always get the canonical script form, never a romanization.
	const base = { id: 'c1', itemIds: ['i1'] };

	it('speaks the correct option of a toTarget multiple choice', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'multiple-choice',
				direction: 'toTarget',
				prompt: 'the menu',
				options: ['筷子', '菜单', '茶', '水'],
				correctIndex: 1
			})
		).toBe('菜单');
	});

	it('speaks the canonical accepted answer of a toTarget typed translation', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'the bill, please',
				acceptedAnswers: ['买单', 'mǎidān', 'maidan']
			})
		).toBe('买单');
	});

	it('speaks a cloze as the whole sentence with the blank filled', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'cloze',
				direction: 'toTarget',
				sentence: '请给我一份___。',
				acceptedAnswers: ['菜单', 'càidān'],
				translationHint: 'A menu, please.'
			})
		).toBe('请给我一份菜单。');
	});

	it('speaks a word-order answer as the assembled sentence, not tile by tile', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'word-order',
				direction: 'toTarget',
				prompt: 'We would like to pay the bill.',
				tiles: ['买单', '我们', '菜单', '想'],
				answerTokens: ['我们', '想', '买单'],
				answer: '我们想买单'
			})
		).toBe('我们想买单');
	});

	it('speaks the corrected spot-error sentence, never the broken one on screen', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'spot-error',
				// toNative, and still spoken: the sentence is target-language whichever
				// way round the challenge is exercised.
				direction: 'toNative',
				tokens: ['我们', '想', '菜单'],
				correctIndex: 2,
				intendedWord: '买单',
				correctedSentence: '我们想买单',
				meaning: 'We would like to pay the bill.'
			})
		).toBe('我们想买单');
	});

	it('is silent when the answer is in the native language, or has no single answer', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'multiple-choice',
				direction: 'toNative',
				prompt: '菜单',
				options: ['the menu', 'the bill', 'the tea', 'the water'],
				correctIndex: 0
			})
		).toBe('');
		expect(
			spokenAnswerFor({
				...base,
				type: 'typed-translation',
				direction: 'toNative',
				prompt: '买单',
				acceptedAnswers: ['to pay the bill']
			})
		).toBe('');
		expect(
			spokenAnswerFor({
				...base,
				type: 'match-pairs',
				direction: 'toNative',
				pairs: [
					{ a: '菜单', b: 'the menu' },
					{ a: '买单', b: 'to pay the bill' }
				]
			})
		).toBe('');
	});

	it('is silent on an empty accepted-answer list rather than speaking a bare gap', () => {
		expect(
			spokenAnswerFor({
				...base,
				type: 'cloze',
				direction: 'toTarget',
				sentence: '请给我一份___。',
				acceptedAnswers: [],
				translationHint: 'A menu, please.'
			})
		).toBe('');
	});
});

describe('sessionSummary', () => {
	const answers: SessionAnswer[] = [
		{ challengeId: 'a', type: 'multiple-choice', verdict: 'correct', itemIds: ['i1'] },
		{ challengeId: 'b', type: 'cloze', verdict: 'almost', itemIds: ['i1', 'i2'] },
		{ challengeId: 'c', type: 'typed-translation', verdict: 'wrong', itemIds: ['i3'] },
		{ challengeId: 'd', type: 'match-pairs', verdict: 'correct', itemIds: [] }
	];

	it('totals verdicts', () => {
		const summary = sessionSummary(answers);
		expect(summary.answered).toBe(4);
		expect(summary.correct).toBe(2);
		expect(summary.almost).toBe(1);
		expect(summary.wrong).toBe(1);
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
			accuracy: 0,
			itemsPracticed: 0
		});
	});
});

/* -------------------------------------------------------------------------- */

describe('planSession', () => {
	it('serves due words first, as the challenges they were stored as', () => {
		const items = [item('a', -DAY), item('b', -10 * DAY), item('c', -3 * DAY)];
		const pool = [row('ca', ['a'], { topic: 'at the market' }), row('cb', ['b']), row('cc', ['c'])];
		const planned = planSession(pool, items, NOW, { target: 3 });

		expect(ids(planned.map((pick) => pick.challenge))).toEqual(['cb', 'cc', 'ca']);
		expect(planned[2]!.challenge).toEqual(challengeOf(pool[0]));
		expect(planned[2]!.challenge).not.toHaveProperty('topic');
		expect(planned[2]!.challenge).not.toHaveProperty('lastServedAt');
		// Each pick carries the help level it is served at and its predicted chance.
		expect(planned[2]!.shown).toBe('plain');
		expect(planned[2]!.chance).toBeGreaterThan(0.65);
	});

	it('respects the target and the ceiling, and never serves what does not fit the word', () => {
		const items = [item('due', -DAY)];
		const pool = Array.from({ length: 30 }, (_, i) =>
			row(`c${i}`, ['due'], { generatedAt: NOW - i })
		);
		expect(planSession(pool, items, NOW, { target: 5 })).toHaveLength(5);
		expect(planSession(pool, items, NOW, { target: 999 })).toHaveLength(SESSION_LENGTH);
		expect(planSession(pool, items, NOW, { target: 999, limit: 3 })).toHaveLength(3);
		expect(planSession([freeProductionRow('typed', ['due'])], items, NOW)).toEqual([]);
	});

	it('is pure: it does not mutate the pool it is given', () => {
		const pool = [row('c1', ['due']), row('c2', ['due'], { generatedAt: NOW })];
		const snapshot = structuredClone(pool);
		planSession(pool, [item('due', -DAY)], NOW);
		expect(pool).toEqual(snapshot);
	});
});

/* -------------------------------------------------------------------------- */

describe('planRefill', () => {
	/** A second demand-0 kind beside {@link recognition}: `produce-mc`. */
	const production = (id: string, itemIds: string[]): ChallengeRow =>
		recognition(id, itemIds, { direction: 'toTarget' });

	/** The distinct words a brief is about, in the order their wants were planned. */
	const wordsOf = (args: { wants: { item: { id: string } }[] }): string[] => [
		...new Set(args.wants.map((want) => want.item.id))
	];

	it('produces getBatch args from an empty collection: nothing to want', () => {
		const plan = planRefill([], [], profile(), NOW);

		expect(plan).toEqual({
			profile: {
				nativeLanguage: 'English',
				targetLanguage: 'Spanish',
				level: 'beginner',
				interests: ['cooking', 'football']
			},
			wants: []
		});
	});

	it('has nothing to want for a word the pool already covers', () => {
		const word = item('a', -DAY);
		const pool = [recognition('r1', ['a']), recognition('r2', ['a'], { direction: 'toTarget' })];
		expect(planRefill(pool, [word], profile(), NOW).wants).toEqual([]);
	});

	it('sends the wants and the vocabulary they are written against, and nothing else', () => {
		// The batch args are the whole request: nothing in them can introduce a
		// word, and nothing about how the learner has been doing rides along.
		const plan = planRefill([], [item('a', -DAY)], profile(), NOW);
		expect(Object.keys(plan).sort()).toEqual(['knownItems', 'profile', 'wants']);
	});

	it('carries only the profile fields the prompt needs', () => {
		const plan = planRefill([], [], profile(), NOW);
		expect(Object.keys(plan.profile).sort()).toEqual([
			'interests',
			'level',
			'nativeLanguage',
			'targetLanguage'
		]);
		expect(plan.profile).not.toHaveProperty('model');
		expect(plan.profile).not.toHaveProperty('createdAt');
	});

	it("threads the learner's self-description through, and omits it when blank", () => {
		const about = 'Nurse in Valencia, two kids, I climb on weekends.';
		expect(planRefill([], [], profile({ about }), NOW).profile.about).toBe(about);

		expect(planRefill([], [], profile(), NOW).profile).not.toHaveProperty('about');
		expect(planRefill([], [], profile({ about: '  ' }), NOW).profile).not.toHaveProperty('about');
	});

	it('sends the whole vocabulary as knownItems, due or not', () => {
		// Only the upcoming words are wanted, so without this list the model
		// builds sentences out of strangers rather than words the learner can
		// already read. Ids ride along for the resolver's term index;
		// `buildRequestPrompt` sends only the terms.
		const items = [item('a', -1 * DAY), item('b', -5 * DAY), item('c', +2 * DAY)];
		const plan = planRefill([], items, profile(), NOW);

		expect(plan.knownItems).toEqual([
			{ id: 'a', term: 'term-a' },
			{ id: 'b', term: 'term-b' },
			{ id: 'c', term: 'term-c' }
		]);
	});

	it('lets a romanization ride along, for the words that have one', () => {
		// The prompt needs it to tell two same-spelled cards apart; a word without one costs nothing for the field.
		const items = [{ ...item('a', -1 * DAY), romanization: 'cháng' }, item('b', -1 * DAY)];
		const plan = planRefill([], items, profile(), NOW);

		expect(plan.knownItems).toEqual([
			{ id: 'a', term: 'term-a', romanization: 'cháng' },
			{ id: 'b', term: 'term-b' }
		]);
	});

	it('wants two challenges per upcoming word, due first and then review-ahead', () => {
		const items = [item('a', -1 * DAY), item('b', -5 * DAY), item('c', +2 * DAY)];
		const plan = planRefill([], items, profile(), NOW);

		// These cards are freshly created, so every word is at the starting skill
		// and only the two recognition kinds can reach it, at their shortest. `c`
		// is not due — it rides along because a top-up has no other source of
		// vocabulary and must not come back empty for a learner who is caught up.
		expect(wordsOf(plan)).toEqual(['b', 'a', 'c']);
		expect(plan.wants.map((w) => w.item.id)).toEqual(['b', 'b', 'a', 'a', 'c', 'c']);
		for (const want of plan.wants) {
			const id = want.item.id;
			expect(want.item).toEqual({ id, term: `term-${id}`, meaning: `meaning-${id}` });
			expect(want.length).toBe(1);
		}
	});

	it('writes production for a word the model has learned is strong', () => {
		const fresh = item('a', -DAY);
		const strong = { ...atStrength(item('b', -DAY), 0.5), skill: 5 };

		const kinds = (id: string) =>
			planRefill([], [fresh, strong], profile(), NOW)
				.wants.filter((w) => w.item.id === id)
				.map((w) => w.kind.type);
		expect(kinds('a').every((k) => k === 'recognize-mc' || k === 'produce-mc')).toBe(true);
		expect(kinds('b')).toHaveLength(2);
		expect(kinds('b').some((k) => k === 'recognize-mc' || k === 'produce-mc')).toBe(false);
	});

	it('wants nothing for a word the pool already covers', () => {
		// Two rested recognition kinds about a new word: it has what a session
		// would serve it, so the brief is empty and the word is not in it.
		const pool = [recognition('r1', ['a']), production('r2', ['a'])];
		const plan = planRefill(pool, [item('a', -DAY)], profile(), NOW);

		expect(plan.wants).toEqual([]);
	});

	it('does not count a row the word has outgrown as coverage', () => {
		const pool = [recognition('r1', ['a'])];
		const owned = { ...atStrength(item('a', -DAY), 0.5), skill: 6 };
		const plan = planRefill(pool, [owned], profile(), NOW);

		expect(plan.wants).toHaveLength(2);
		expect(plan.wants.map((w) => w.kind.type)).not.toContain('recognize-mc');
		expect(wordsOf(plan)).toEqual(['a']);
	});

	it('walks every word the learner has, most overdue first', () => {
		const items = [item('c', -DAY), item('a', -3 * DAY), item('b', -2 * DAY)];
		const plan = planRefill([], items, profile(), NOW);

		expect(wordsOf(plan)).toEqual(['a', 'b', 'c']);
		expect(plan.wants).toHaveLength(6);
	});

	it('includes a trimmed topic in the batch args when one is given', () => {
		const plan = planRefill([], [], profile(), NOW, { topic: '  ordering in a restaurant  ' });
		expect(plan.topic).toBe('ordering in a restaurant');
	});

	it('omits topic entirely when absent or blank', () => {
		expect(planRefill([], [], profile(), NOW)).not.toHaveProperty('topic');
		expect(planRefill([], [], profile(), NOW, { topic: '   ' })).not.toHaveProperty('topic');
		expect(planRefill([], [], profile(), NOW, { topic: '' })).not.toHaveProperty('topic');
	});

	it('is pure: it does not mutate the pool or the items it is given', () => {
		const items = [item('a', -DAY), item('b', +DAY)];
		const pool = [recognition('r1', ['a'])];
		const snapshot = structuredClone({ items, pool });
		planRefill(pool, items, profile(), NOW);
		expect({ items, pool }).toEqual(snapshot);
	});

	it('still writes about a word that was just reviewed, as review-ahead', () => {
		// It is no longer due, and it is the only word there is. Excluding it would
		// hand the model an empty brief; a challenge about it is graded normally
		// when it is played, just for a smaller stability gain.
		const plan = planRefill([], [strongItem('a', +5 * DAY)], profile(), NOW);
		expect(wordsOf(plan)).toEqual(['a']);
		expect(plan.wants.length).toBeGreaterThan(0);
	});
});

/* -------------------------------------------------------------------------- */

describe('a skipped challenge', () => {
	it('grades FSRS Again', () => {
		// A skip is "I could not produce it", which is exactly what Again encodes.
		expect(gradeFromResult('wrong')).toBe(Grade.Again);
	});

	it('counts as a wrong answer in the session summary', () => {
		const summary = sessionSummary([
			{ challengeId: 'a', type: 'cloze', verdict: 'correct', itemIds: ['i1'] },
			{ challengeId: 'b', type: 'cloze', verdict: 'wrong', itemIds: ['i2'] }
		]);
		expect(summary.wrong).toBe(1);
		expect(summary.accuracy).toBe(0.5);
	});
});

describe('planRefill → getBatch (mock mode)', () => {
	beforeAll(loadWasmCore);

	it('runs in mock mode under node (no API key)', () => {
		expect(isMockMode()).toBe(true);
	});

	it('fills every want with a challenge about a word we sent, and introduces none', async () => {
		const items = [item('a', -2 * DAY), item('b', -DAY)];
		const plan = planRefill([], items, profile(), NOW);
		const batch = await getBatch(plan);

		expect(batch.challenges).toHaveLength(plan.wants.length);
		expect(batch).not.toHaveProperty('newItems');
		const known = new Set(items.map((i) => i.id));
		for (const challenge of batch.challenges) {
			expect(challenge.itemIds.length).toBeGreaterThan(0);
			for (const id of challenge.itemIds) expect(known.has(id)).toBe(true);
		}
		expect(batch.usage).toEqual({ promptTokens: 0, completionTokens: 0, requests: 0 });
		expect(batch.failedRequests).toBe(0);
	});

	it('says there is nothing to write when the learner has no words', async () => {
		await expect(getBatch(planRefill([], [], profile(), NOW))).rejects.toThrow(/nothing to write/);
	});

	it('walks the same progress steps as the real path, instantly', async () => {
		const steps: ProgressStep[] = [];
		const plan = planRefill([], [item('a', -DAY)], profile(), NOW);
		await getBatch(plan, { onProgress: (s) => steps.push(s) });
		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
	});

	it('writes the kinds each word can manage', async () => {
		const items = [item('a', -2 * DAY), { ...atStrength(item('b', -DAY), 0.5), skill: 5 }];
		const batch = await getBatch(planRefill([], items, profile(), NOW));
		const types = new Set(batch.challenges.map((c) => c.type));

		expect(types.has('multiple-choice') || types.has('typed-translation')).toBe(true);
		expect(types.has('cloze') || types.has('word-order') || types.has('multi-cloze')).toBe(true);
	});
});

/* -------------------------------------------------------------------------- */

/**
 * A dry run of the loop `src/routes/learn/+page.svelte` drives, with the
 * database swapped for arrays and the learner swapped for a scripted answer
 * function. It exercises the parts that are easy to get subtly wrong — where
 * the free match rounds land, how many challenges a session actually plays, and
 * what the summary makes of them — against a real mock batch, planned the way a
 * real session is planned.
 */
describe('session walkthrough (mock batch, no database)', () => {
	beforeAll(loadWasmCore);

	/** Plays a session the way the page does; `answerAs` scripts the learner. */
	async function playSession(
		known: KnowledgeItem[],
		answerAs: (challenge: Challenge, index: number) => Verdict
	) {
		const plan = planRefill([], known, profile(), NOW);
		const batch = await getBatch(plan);

		// The vocabulary is exactly what went in — generating changes nothing about
		// it — and what `addToPool` writes is a fresh, never-served batch.
		const items = known;
		const pool: ChallengeRow[] = batch.challenges.map((challenge, index) => ({
			...challenge,
			generatedAt: NOW + index,
			timesServed: 0,
			lastServedAt: null,
			reported: false
		}));

		// The session is planned once, up front — no database read mid-play — and
		// the free rounds are spliced in there too, so play is one walk.
		const planned = planSession(pool, items, NOW).map((pick) => pick.challenge);
		const queue = interleaveMatchRounds(planned, items);

		const answers: SessionAnswer[] = [];
		let llmAnswered = 0;
		let matchRounds = 0;

		for (const challenge of queue) {
			if (llmAnswered >= SESSION_LENGTH) break;

			const isMatch = challenge.type === 'match-pairs';
			if (isMatch) matchRounds++;
			const verdict = isMatch ? 'correct' : answerAs(challenge, llmAnswered);

			if (!isMatch) llmAnswered++;
			answers.push({
				challengeId: challenge.id,
				type: challenge.type,
				verdict,
				itemIds: isMatch ? [] : challenge.itemIds
			});
		}

		return {
			answers,
			matchRounds,
			llmAnswered,
			summary: sessionSummary(answers),
			planned,
			unplayed: planned.length - llmAnswered
		};
	}

	it('plays a flawless session with only early-level active formats', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, () => 'correct');

		// Two challenges per word, the mock filling every want, played to the
		// end: the session is sized by what was planned, and nothing is left over.
		expect(run.llmAnswered).toBe(14);
		expect(run.unplayed).toBe(0);
		expect(run.matchRounds).toBe(3); // after every 4th early-material answer
		expect(run.answers).toHaveLength(17);
		expect(run.summary.accuracy).toBe(1);
		expect(run.summary.correct).toBe(17);
	});

	it('counts a single miss without disturbing the rest of the session', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, (_challenge, index) =>
			index === 4 ? 'wrong' : 'correct'
		);

		expect(run.llmAnswered).toBe(14);
		expect(run.summary.wrong).toBe(1);
		expect(run.summary.answered).toBe(17);
	});

	it('ends gracefully when the plan is shorter than a full session', async () => {
		const run = await playSession([item('a', -DAY)], () => 'correct');
		expect(run.planned.length).toBeLessThan(SESSION_LENGTH);
		expect(run.llmAnswered).toBe(run.planned.length);
		expect(run.unplayed).toBe(0);
	});

	it('match rounds carry no item ids into the summary', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, () => 'correct');

		for (const answer of run.answers) {
			if (answer.type === 'match-pairs') expect(answer.itemIds).toEqual([]);
			else expect(answer.itemIds.length).toBeGreaterThan(0);
		}
	});
});
