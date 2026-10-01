/**
 * Unit tests for the session engine's pure half, through the wasm core.
 *
 * The decisions are Rust's and tested there (`crates/sapling-challenges`'
 * `stream.rs` and `topup.rs`); what is left here is the seam — positions
 * mapped back to the stored rows, the batch arguments built around the
 * wants — plus the session accounting, and a mock top-up streamed end to end.
 * The database-touching half (`applyResult`, `generateChallenges`,
 * `practiceOverview`, `./stream`) is a thin wrapper, like
 * `src/lib/db/repositories.ts`, and `stream.test.ts` runs it against a store.
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
	MATCH_PAIRS_EVERY,
	isEarlyChallenge,
	lowWaterMark,
	matchRound,
	nextPick,
	planRefill,
	planTopUp,
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

/* -------------------------------------------------------------------------- */

describe('match rounds', () => {
	const known = (n: number) => Array.from({ length: n }, (_, i) => item(`k${i}`, -DAY));

	it('come from early words, five pairs, and a seed replays them', () => {
		const round = matchRound(known(8), 1)!;
		expect(round.type).toBe('match-pairs');
		expect(round.pairs).toHaveLength(5);
		expect(matchRound(known(8), 1)!.itemIds).toEqual(round.itemIds);
		expect(matchRound(known(2), 1)).toBeNull();
		expect(matchRound([strongItem('a', -DAY), strongItem('b', -DAY), strongItem('c', -DAY)])).toBe(
			null
		);
	});

	it('follow challenges about early words only', () => {
		const words = [item('new', -DAY), strongItem('owned', -DAY)];
		expect(isEarlyChallenge(challengeOf(row('c1', ['new'])), words)).toBe(true);
		expect(isEarlyChallenge(challengeOf(row('c2', ['owned'])), words)).toBe(false);
		expect(MATCH_PAIRS_EVERY).toBe(4);
	});
});

/* -------------------------------------------------------------------------- */

describe('nextPick', () => {
	it('serves the most overdue word first, as the challenge it was stored as', () => {
		const items = [item('a', -DAY), item('b', -10 * DAY), item('c', -3 * DAY)];
		const pool = [row('ca', ['a'], { topic: 'at the market' }), row('cb', ['b']), row('cc', ['c'])];

		const first = nextPick(pool, items, NOW)!;
		expect(first.challenge.id).toBe('cb');
		expect(first.due).toBe(true);
		const only = nextPick(pool, [items[0]], NOW)!;
		expect(only.challenge).toEqual(challengeOf(pool[0]));
		expect(only.challenge).not.toHaveProperty('topic');
		expect(only.challenge).not.toHaveProperty('lastServedAt');
		// Each pick carries the help level it is served at and its remembered chance.
		expect(only.shown).toBe('plain');
		expect(only.chance).toBeGreaterThan(0.72);
	});

	it('never skips the most urgent word, even when another has something', () => {
		const items = [item('a', -DAY), item('b', -10 * DAY)];
		const pool = [row('ca', ['a']), row('cb', ['b'])];
		expect(nextPick(pool, items, NOW, { served: ['cb'] })).toBeNull();
	});

	it('never serves what does not fit the word', () => {
		expect(nextPick([freeProductionRow('typed', ['due'])], [item('due', -DAY)], NOW)).toBeNull();
	});

	it('is pure: it does not mutate the pool it is given', () => {
		const pool = [row('c1', ['due']), row('c2', ['due'], { generatedAt: NOW })];
		const snapshot = structuredClone(pool);
		nextPick(pool, [item('due', -DAY)], NOW);
		expect(pool).toEqual(snapshot);
	});
});

describe('refill', () => {
	it('writes for the words ahead up to the mark, never twice, and a shown row covers nothing', () => {
		const items = [item('a', -2 * DAY), item('b', -DAY), item('c', DAY)];
		const pool = [row('ca', ['a'])];
		const ids = (wants: { item: { id: string } }[]) => [...new Set(wants.map((w) => w.item.id))];
		expect(ids(planTopUp(pool, items, NOW, { limit: 2 }))).toEqual(['b']);
		expect(ids(planTopUp(pool, items, NOW, { limit: 2, served: ['ca'] }))).toEqual(['a', 'b']);
		expect(ids(planTopUp(pool, items, NOW))).toEqual(['b', 'c']);
		expect(ids(planTopUp(pool, items, NOW, { asked: ['b'] }))).toEqual(['c']);
	});

	it('keeps more words written for the faster the learner answers', () => {
		expect(lowWaterMark()).toBe(5);
		expect(lowWaterMark(5_000, 60_000)).toBeGreaterThan(lowWaterMark(30_000, 60_000));
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
		// and wants two different kinds it can reach, short ones. `c`
		// is not due — it rides along because a top-up has no other source of
		// vocabulary and must not come back empty for a learner who is caught up.
		expect(wordsOf(plan)).toEqual(['b', 'a', 'c']);
		expect(plan.wants.map((w) => w.item.id)).toEqual(['b', 'b', 'a', 'a', 'c', 'c']);
		for (const want of plan.wants) {
			const id = want.item.id;
			expect(want.item).toEqual({ id, term: `term-${id}`, meaning: `meaning-${id}` });
			expect(want.length).toBeLessThanOrEqual(3);
		}
		for (let i = 0; i < plan.wants.length; i += 2) {
			expect(plan.wants[i].kind).not.toEqual(plan.wants[i + 1].kind);
		}
	});

	it('writes production for a word the model has learned is strong', () => {
		const fresh = item('a', -DAY);
		const strong = { ...atStrength(item('b', -DAY), 0.5), skill: 5 };

		const kinds = (id: string) =>
			planRefill([], [fresh, strong], profile(), NOW)
				.wants.filter((w) => w.item.id === id)
				.map((w) => w.kind.type);
		const production = ['cloze', 'word-order', 'multi-cloze', 'translate-to-target'];
		expect(kinds('a')).toHaveLength(2);
		expect(kinds('a').some((k) => production.includes(k))).toBe(false);
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
		const plan = planRefill([], known, profile(), NOW, { seed: 1 });
		const batch = await getBatch(plan);

		// The vocabulary is exactly what went in — generating changes nothing about
		// it — and what `addToPool` writes is a fresh, never-served batch.
		const items = [...known];
		const pool: ChallengeRow[] = batch.challenges.map((challenge, index) => ({
			...challenge,
			generatedAt: NOW + index,
			timesServed: 0,
			lastServedAt: null,
			reported: false
		}));

		// One pick at a time, as the stream makes them — here without the store,
		// so an answer only moves its word's due date, and each pick is kept from
		// coming back by the stream's own served list. A round follows every
		// fourth early-word challenge, and only when a pick follows it.
		const served: string[] = [];
		const answers: SessionAnswer[] = [];
		let llmAnswered = 0;
		let matchRounds = 0;
		let earlySinceRound = 0;

		for (;;) {
			const pick = nextPick(pool, items, NOW, { served });
			if (!pick) break;
			if (earlySinceRound >= MATCH_PAIRS_EVERY) {
				earlySinceRound = 0;
				const round = matchRound(items, matchRounds);
				if (round) {
					matchRounds++;
					answers.push({
						challengeId: round.id,
						type: round.type,
						verdict: 'correct',
						itemIds: []
					});
				}
			}
			served.push(pick.challenge.id);
			const challenge = pick.challenge;
			answers.push({
				challengeId: challenge.id,
				type: challenge.type,
				verdict: answerAs(challenge, llmAnswered),
				itemIds: challenge.itemIds
			});
			llmAnswered++;
			if (isEarlyChallenge(challenge, items)) earlySinceRound++;
			// Reviewed: the word goes to the back of the line, still new to the model.
			for (const id of challenge.itemIds) {
				const at = items.findIndex((i) => i.id === id);
				items[at] = {
					...items[at],
					srs: { ...items[at].srs!, due: NOW + (100 + llmAnswered) * DAY }
				};
			}
		}

		return {
			answers,
			matchRounds,
			llmAnswered,
			summary: sessionSummary(answers),
			written: pool.length
		};
	}

	it('streams every challenge a batch wrote for new words, with rounds between', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, () => 'correct');

		// Two challenges per word, the mock filling every want. The mock writes
		// its fixture at the fixture's own length, not the one asked for, but a
		// row is judged at the length it was asked for, so every row fits its
		// word and the stream serves them all.
		expect(run.written).toBe(14);
		expect(run.llmAnswered).toBe(14);
		expect(run.matchRounds).toBe(Math.floor((run.llmAnswered - 1) / 4)); // after every 4th early-material answer, never last
		expect(run.answers).toHaveLength(run.llmAnswered + run.matchRounds);
		expect(run.summary.accuracy).toBe(1);
		expect(run.summary.correct).toBe(run.answers.length);
	});

	it('counts a single miss without disturbing the rest of the session', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, (_challenge, index) =>
			index === 4 ? 'wrong' : 'correct'
		);

		expect(run.llmAnswered).toBe(14);
		expect(run.summary.wrong).toBe(1);
		expect(run.summary.answered).toBe(run.llmAnswered + run.matchRounds);
	});

	it('ends when nothing is left that fits', async () => {
		const run = await playSession([item('a', -DAY)], () => 'correct');
		expect(run.llmAnswered).toBeGreaterThan(0);
		expect(run.llmAnswered).toBeLessThanOrEqual(run.written);
		expect(run.matchRounds).toBe(0);
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
