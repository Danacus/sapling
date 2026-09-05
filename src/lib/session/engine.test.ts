/**
 * Unit tests for the pure half of the session engine.
 *
 * The database-touching half (`applyResult`, `generateChallenges`,
 * `startSession`) needs a live store, which this file does not set up, so it
 * is covered by the same "thin wrapper, no logic" rule as
 * `src/lib/db/repositories.ts`:
 * everything worth asserting was pushed down into `planSession` /
 * `planRefill` / `sessionSummary`, which are exercised here.
 *
 * The one exception is {@link planRefill}'s output being fed to the real
 * `getBatch` in mock mode (no API key in node ⇒ mock automatically), which
 * smoke-tests the whole generate → resolve path against a real plan.
 */

import { describe, expect, it } from 'vitest';

import type { ChallengeRow } from '$lib/db';
import { getBatch, isMockMode, kindKey } from '$lib/llm';
import type { ProgressStep } from '$lib/llm';
import { CardState, gradeFromResult, newCardState, reviewCard, Grade } from '$lib/srs';
import type {
	Challenge,
	KnowledgeItem,
	MultipleChoiceChallenge,
	Profile,
	Verdict
} from '$lib/types';
import {
	BATCH_TARGET,
	LISTENING_SHARE,
	MATCH_PAIRS_EVERY,
	RESERVE_GAP,
	SESSION_LENGTH,
	interleaveMatchRounds,
	isListeningChallenge,
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

/** An item whose card is due `dueOffset` ms from `NOW` (negative = overdue). */
function item(
	id: string,
	dueOffset: number,
	history: KnowledgeItem['history'] = []
): KnowledgeItem {
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

/** A pooled challenge; defaults to freshly generated and never served. */
function row(id: string, itemIds: string[], over: Partial<ChallengeRow> = {}): ChallengeRow {
	return {
		id,
		type: 'typed-translation',
		direction: 'toTarget',
		prompt: `prompt-${id}`,
		acceptedAnswers: ['a'],
		itemIds,
		generatedAt: NOW - DAY,
		timesServed: 0,
		lastServedAt: null,
		reported: false,
		...over
	} as ChallengeRow;
}

/** A pooled challenge served recently enough that it is still resting. */
function resting(id: string, itemIds: string[], servedAgo: number): ChallengeRow {
	return row(id, itemIds, { timesServed: 1, lastServedAt: NOW - servedAgo });
}

/**
 * A pooled multiple-choice row — demand 0, so any word can bear it, where
 * {@link row}'s typed-translation default is demand 2 and none of the fresh
 * cards {@link item} builds can. The pair is what the bearability tests below
 * choose between.
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
 * A word the learner owns: ten days of stability, reviewed just now, so
 * `wordStrength` clears `FREE_PRODUCTION_FLOOR` and every demand tier is
 * bearable. {@link item}'s card is `newCardState`, which sits at strength 0.
 */
function strongItem(id: string, dueOffset: number): KnowledgeItem {
	return {
		...item(id, dueOffset),
		fsrsCard: {
			...newCardState(NOW),
			due: NOW + dueOffset,
			stability: 10,
			scheduled_days: 10,
			reps: 5,
			state: CardState.Review,
			last_review: NOW
		}
	};
}

/**
 * A word partway up level 1: `wordStrength` ≈ 0.10, which is above the band's
 * centre (0.075) and below its ceiling (`CONSTRAINED_PRODUCTION_FLOOR`, 0.15).
 * Exactly where matching a challenge against the word's *raw* strength used to
 * degenerate — every tier-0 row sits below 0.10, so the tier's hardest was
 * always the nearest.
 */
function midLevelOneItem(id: string, dueOffset: number): KnowledgeItem {
	return {
		...item(id, dueOffset),
		fsrsCard: {
			...newCardState(NOW),
			due: NOW + dueOffset,
			// log1p(0.41) / log1p(30) ≈ 0.10, and retrievability is 1 the moment of
			// a review — see `wordStrength`.
			stability: 0.41,
			scheduled_days: 1,
			reps: 1,
			state: CardState.Review,
			last_review: NOW
		}
	};
}

const ids = (challenges: Challenge[]) => challenges.map((challenge) => challenge.id);

/* -------------------------------------------------------------------------- */

describe('interleaveMatchRounds', () => {
	/** `n` generated challenges, distinguishable by id. */
	const generated = (n: number): Challenge[] =>
		Array.from({ length: n }, (_, i) => row(`c${i}`, ['k0']) as Challenge);

	const known = (n: number) => Array.from({ length: n }, (_, i) => item(`k${i}`, -DAY));

	const types = (challenges: Challenge[]) => challenges.map((challenge) => challenge.type);

	/** A deterministic `[0,1)` sequence, so two rounds get *different* draws. */
	function lcg(seed: number): () => number {
		let state = seed;
		return () => {
			state = (state * 1664525 + 1013904223) % 4294967296;
			return state / 4294967296;
		};
	}

	it('slots a round in after every Nth challenge', () => {
		const queue = interleaveMatchRounds(generated(9), known(6), NOW);

		expect(queue).toHaveLength(11);
		expect(types(queue).map((type) => type === 'match-pairs')).toEqual([
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
		// The generated challenges keep their planned order around the rounds.
		expect(
			queue.filter((challenge) => challenge.type !== 'match-pairs').map((challenge) => challenge.id)
		).toEqual(ids(generated(9)));
	});

	it('never ends a session on free filler', () => {
		// An exact multiple of N: the last splice point is the last challenge.
		const queue = interleaveMatchRounds(generated(2 * MATCH_PAIRS_EVERY), known(6), NOW);

		expect(queue).toHaveLength(2 * MATCH_PAIRS_EVERY + 1);
		expect(queue.at(-1)?.type).not.toBe('match-pairs');
		expect(queue[MATCH_PAIRS_EVERY].type).toBe('match-pairs');
	});

	it('returns an empty queue for an empty plan', () => {
		expect(interleaveMatchRounds([], known(6), NOW)).toEqual([]);
	});

	it('leaves the plan alone when a round cannot be built', () => {
		// Below the ladder's own floor of three usable items:
		// `makeMatchPairsChallenge` declines, and with static items that means no
		// round anywhere.
		const plan = generated(9);
		expect(interleaveMatchRounds(plan, known(2), NOW)).toEqual(plan);
	});

	it('builds each round independently, and deterministically from its rng', () => {
		const queue = interleaveMatchRounds(generated(9), known(8), NOW, lcg(1));
		const rounds = queue.filter((challenge) => challenge.type === 'match-pairs');

		expect(rounds).toHaveLength(2);
		expect(rounds[0].id).not.toBe(rounds[1].id);
		// Fresh shuffle per splice point: the second round is not a copy of the first.
		expect(rounds[0].itemIds).not.toEqual(rounds[1].itemIds);

		const again = interleaveMatchRounds(generated(9), known(8), NOW, lcg(1));
		expect(
			again
				.filter((challenge) => challenge.type === 'match-pairs')
				.map((challenge) => challenge.itemIds)
		).toEqual(rounds.map((challenge) => challenge.itemIds));
	});

	/**
	 * The rounds are the one part of a session nobody pays for. These pin the
	 * ladder reaching them, and — more importantly — pin *which* rung a round of
	 * mixed vocabulary is written at.
	 */
	describe('sizing off the ladder', () => {
		const pairsOf = (queue: Challenge[]) =>
			queue
				.filter((challenge) => challenge.type === 'match-pairs')
				.map((challenge) => (challenge.type === 'match-pairs' ? challenge.pairs.length : 0));

		it('gives new words a three-pair breather', () => {
			// `item`'s card is `newCardState`: strength 0, so every word is rung 1.
			expect(pairsOf(interleaveMatchRounds(generated(9), known(8), NOW))).toEqual([3, 3]);
		});

		it('gives a vocabulary the learner owns the full six', () => {
			const strong = Array.from({ length: 8 }, (_, i) => strongItem(`k${i}`, -DAY));
			expect(pairsOf(interleaveMatchRounds(generated(9), strong, NOW))).toEqual([6, 6]);
		});

		it('takes the median rung, so one mature word cannot size the round', () => {
			// Seven brand-new words and one the learner owns outright: the median is
			// still rung 1, and the round is still the three-pair breather.
			const mixed = [
				...Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY)),
				strongItem('k7', -DAY)
			];
			expect(pairsOf(interleaveMatchRounds(generated(5), mixed, NOW))).toEqual([3]);
		});

		it('follows the median up when most of the vocabulary is strong', () => {
			// The mirror image: one new word among seven strong ones moves nothing.
			const mixed = [
				...Array.from({ length: 7 }, (_, i) => strongItem(`k${i}`, -DAY)),
				item('k7', -DAY)
			];
			expect(pairsOf(interleaveMatchRounds(generated(5), mixed, NOW))).toEqual([6]);
		});

		it('builds a smaller round rather than none when the vocabulary is short', () => {
			// Rung 5 asks for six pairs and there are four words to make them from.
			const strong = Array.from({ length: 4 }, (_, i) => strongItem(`k${i}`, -DAY));
			expect(pairsOf(interleaveMatchRounds(generated(5), strong, NOW))).toEqual([4]);
		});
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

describe('isListeningChallenge', () => {
	/** A recognize-MC row: target text shown, native meaning picked. */
	function recognize(id: string, prompt = '菜单'): MultipleChoiceChallenge {
		return {
			id,
			type: 'multiple-choice',
			direction: 'toNative',
			prompt,
			options: ['the menu', 'the bill', 'the tea', 'the water'],
			correctIndex: 0,
			itemIds: ['i1']
		};
	}

	/** Ids are only hashed, so any spread of them samples the share fairly. */
	const ids = Array.from({ length: 400 }, (_, i) => `challenge-${i}`);

	it('is off entirely when the learner switched it off', () => {
		expect(ids.some((id) => isListeningChallenge(recognize(id), false))).toBe(false);
	});

	it('takes only recognize-style multiple choice: nothing else has a target prompt', () => {
		const ineligible: Challenge[] = [
			{
				id: 'c1',
				type: 'multiple-choice',
				// The prompt is the learner's own language here; playing it teaches nothing.
				direction: 'toTarget',
				prompt: 'the menu',
				options: ['菜单', '筷子', '茶', '水'],
				correctIndex: 0,
				itemIds: ['i1']
			},
			{
				id: 'c2',
				type: 'cloze',
				direction: 'toTarget',
				sentence: '请给我一份___。',
				acceptedAnswers: ['菜单'],
				translationHint: 'A menu, please.',
				itemIds: ['i1']
			},
			{
				id: 'c3',
				type: 'typed-translation',
				direction: 'toNative',
				prompt: '买单',
				acceptedAnswers: ['to pay the bill'],
				itemIds: ['i1']
			},
			{
				id: 'c4',
				type: 'match-pairs',
				direction: 'toNative',
				pairs: [
					{ a: '菜单', b: 'the menu' },
					{ a: '买单', b: 'to pay the bill' }
				],
				itemIds: ['i1']
			}
		];

		for (const challenge of ineligible) {
			// Tried under every id, so a hash that happens to fall in range cannot
			// make an ineligible type look eligible.
			for (const id of ids.slice(0, 40)) {
				expect(isListeningChallenge({ ...challenge, id }, true)).toBe(false);
			}
		}
	});

	it('takes roughly the configured share of eligible challenges', () => {
		const taken = ids.filter((id) => isListeningChallenge(recognize(id), true)).length;
		const share = taken / ids.length;
		// Neither "always" nor "never": a session mixes reading and listening.
		expect(share).toBeGreaterThan(LISTENING_SHARE - 0.1);
		expect(share).toBeLessThan(LISTENING_SHARE + 0.1);
	});

	it('decides the same way every time for the same challenge', () => {
		// A pooled challenge comes back round; it must not flip presentation
		// between sessions or between devices.
		for (const id of ids.slice(0, 50)) {
			const first = isListeningChallenge(recognize(id), true);
			expect(isListeningChallenge(recognize(id), true)).toBe(first);
		}
	});

	it('never hides a prompt that has nothing to say', () => {
		for (const id of ids.slice(0, 40)) {
			expect(isListeningChallenge(recognize(id, '   '), true)).toBe(false);
		}
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
	it('serves a due word before a brand-new challenge about a word that is not due', () => {
		const items = [item('due', -5 * DAY), item('fine', +5 * DAY)];
		const pool = [
			row('fresh', ['fine'], { generatedAt: NOW }),
			row('old-but-due', ['due'], { generatedAt: NOW - 30 * DAY })
		];

		// The load-bearing case: a global freshness weight would put `fresh`
		// first here, and every new batch would then bury spaced repetition.
		expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['old-but-due']);
	});

	it('orders due items most-overdue first', () => {
		const items = [item('a', -DAY), item('b', -10 * DAY), item('c', -3 * DAY)];
		const pool = [row('ca', ['a']), row('cb', ['b']), row('cc', ['c'])];

		expect(ids(planSession(pool, items, NOW, { target: 3 }))).toEqual(['cb', 'cc', 'ca']);
	});

	it('prefers a never-served challenge over a served one for the same word', () => {
		const items = [item('due', -DAY)];
		const pool = [
			row('served', ['due'], { timesServed: 1, lastServedAt: NOW - 10 * DAY }),
			row('unseen', ['due'])
		];

		expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['unseen']);
	});

	it('breaks ties between never-served challenges by newest generation', () => {
		const items = [item('due', -DAY)];
		const pool = [
			row('older', ['due'], { generatedAt: NOW - 2 * DAY }),
			row('newest', ['due'], { generatedAt: NOW })
		];

		expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['newest']);
	});

	it('recycles the least recently served challenge first', () => {
		const items = [item('due', -DAY)];
		const pool = [
			row('recent', ['due'], { timesServed: 2, lastServedAt: NOW - 4 * DAY }),
			row('stale', ['due'], { timesServed: 5, lastServedAt: NOW - 30 * DAY })
		];

		expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['stale', 'recent']);
	});

	it('prefers a rested challenge over one still inside the gap', () => {
		const items = [item('due', -DAY)];
		const tooSoon = row('hot', ['due'], { timesServed: 1, lastServedAt: NOW - RESERVE_GAP + 1 });
		const rested = row('rested', ['due'], { timesServed: 1, lastServedAt: NOW - RESERVE_GAP });

		// The rested row leads: the second pass is rested-only, so the resting one
		// is fallback material, never a second angle. It is only reached at all
		// because the last-resort filler would rather re-run it than end early.
		expect(ids(planSession([tooSoon, rested], items, NOW))).toEqual(['rested', 'hot']);
	});

	describe('the rest gap yields to a due word', () => {
		it('serves a resting challenge when a due word has no rested one', () => {
			// The reported bug: two hard days stamp the whole pool, the young cards
			// come due within hours, and a hard gap leaves the learner with words due
			// and nothing playable.
			const items = [item('due', -DAY)];
			const pool = [resting('hot', ['due'], DAY)];

			expect(ids(planSession(pool, items, NOW))).toEqual(['hot']);
		});

		it('falls back to the least recently served of them', () => {
			const items = [item('due', -DAY)];
			const pool = [
				resting('yesterday', ['due'], DAY),
				resting('two-days', ['due'], 2 * DAY),
				resting('an-hour', ['due'], 60 * 60 * 1000)
			];

			expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['two-days']);
		});

		it('gives every due word one before any of them gets a second', () => {
			const items = [item('a', -2 * DAY), item('b', -DAY)];
			const pool = [
				resting('a1', ['a'], 2 * DAY),
				resting('a2', ['a'], DAY),
				resting('b1', ['b'], DAY)
			];

			// The walk spends the gap once per word, so `a` cannot take a second
			// angle out of it while `b` still owes its first. `a2` does come back —
			// but only from the last-resort filler, behind every other word's turn.
			expect(ids(planSession(pool, items, NOW, { target: 4 }))).toEqual(['a1', 'b1', 'a2']);
		});

		it('keeps resting material behind every rested row, due or not', () => {
			const items = [item('due', -DAY), item('later', +5 * DAY)];
			const pool = [
				row('due-rested', ['due']),
				resting('later-hot', ['later'], DAY),
				resting('due-hot', ['due'], DAY)
			];

			// `due` takes its rested row, and `later` may not bend the gap in the
			// walk at all. Both resting rows are still reachable — last, from the
			// filler, in serve order — because a re-read beats a short session.
			expect(ids(planSession(pool, items, NOW, { target: 4 }))).toEqual([
				'due-rested',
				'due-hot',
				'later-hot'
			]);
		});

		it('still refuses reported rows and rows whose words are gone', () => {
			const items = [item('due', -DAY)];
			const pool = [
				row('flagged', ['due'], { timesServed: 1, lastServedAt: NOW - DAY, reported: true }),
				resting('orphan', ['due', 'deleted'], DAY),
				resting('itemless', [], DAY)
			];

			// Playability is the absolute half of eligibility: the gap yields, this
			// never does.
			expect(ids(planSession(pool, items, NOW))).toEqual([]);
		});

		it('spends the gap for a never-reviewed word exactly as for a reviewed one', () => {
			const items = [item('never', -DAY), item('seen', -DAY, [{ at: NOW - DAY, grade: 3 }])];
			const pool = [resting('c-never', ['never'], DAY), resting('c-seen', ['seen'], DAY)];

			// A word the learner picked up in conversation and has never been drilled
			// on is due work like any other; nothing about a plan sorts on history.
			expect(ids(planSession(pool, items, NOW)).sort()).toEqual(['c-never', 'c-seen']);
		});
	});

	describe('a challenge a word can bear beats one it cannot', () => {
		// `recognition` is demand 0 and `row` is a toTarget typed translation,
		// demand 2; `item` builds a fresh card at strength 0 and `strongItem` one
		// past FREE_PRODUCTION_FLOOR. See `./progression`.

		it('gives a weak due word the recognition challenge over the production one', () => {
			const items = [item('due', -DAY)];
			const pool = [
				// Freshness would take the typed translation first: it is the newer
				// never-served row. Bearability outranks freshness within the bucket.
				row('typed', ['due'], { generatedAt: NOW }),
				recognition('choice', ['due'], { generatedAt: NOW - 5 * DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['choice']);
			// And the production one is still second, not dropped.
			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['choice', 'typed']);
		});

		it('still serves the production challenge when it is the only one', () => {
			// The invariant that keeps this a preference: a hard exercise beats a
			// skipped review, so a due word is never starved for being weak.
			const items = [item('due', -DAY)];
			const pool = [row('typed', ['due'], { generatedAt: NOW })];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['typed']);
		});

		it('prefers the closer-fitting challenge over the fresher one for a word that can bear both', () => {
			// Both bearable for a strong item, so bearability alone has nothing to
			// prefer — but they are not equally good a fit: a typed-translation
			// (difficulty ~0.5) sits far closer to this word's own strength
			// (~0.7) than a two-word multiple-choice (difficulty ~0.02). Freshness
			// would pick `choice` (the newer, never-served row); fit overrides it.
			const items = [strongItem('due', -DAY)];
			const pool = [
				recognition('choice', ['due'], { generatedAt: NOW }),
				row('typed', ['due'], { generatedAt: NOW - 5 * DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['typed', 'choice']);
		});

		it('still breaks a true fit tie on freshness, exactly as before this preference existed', () => {
			// Two multiple-choice rows of the same prompt length are an equally good
			// (or bad) fit for a strong word, so fit has nothing to decide between
			// them and freshness — the newer, never-served row — settles it.
			const items = [strongItem('due', -DAY)];
			const pool = [
				recognition('newer', ['due'], { generatedAt: NOW }),
				recognition('older', ['due'], { generatedAt: NOW - 5 * DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['newer', 'older']);
		});

		it("aims at the middle of the word's level band, not at its raw strength", () => {
			// The word sits at strength ~0.10: level 1, but in the *upper* half of
			// level 1's [0, 0.15] band. Measured against 0.10 every recognition row
			// in existence reads too easy, so the tier's hardest — the longest
			// sentence anyone ever wrote for this word — was always the nearest, and
			// the short row generated at level 1 could never win. Measured against
			// the band's centre (0.075) the short one does, which is the row a
			// level-1 lesson was asked for in the first place.
			const items = [midLevelOneItem('mid', -DAY)];
			const pool = [
				recognition('long', ['mid'], {
					prompt: 'perdona, ¿me podrías decir dónde está la estación de tren más cercana?',
					generatedAt: NOW
				}),
				recognition('short', ['mid'], { prompt: 'el perro', generatedAt: NOW - 5 * DAY })
			];

			// Freshness would take `long`: it is the newer never-served row.
			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['short', 'long']);
		});

		it('does not spend the rest gap to find something bearable', () => {
			// The preference works *within* a bucket, so the rested bucket is still
			// consulted first and an unbearable rested row wins over a bearable
			// resting one — even though the resting one is the better fit. The gap
			// yields on its own terms (a due word with nothing rested) or not at
			// all until the filler, never to chase a fit.
			const items = [item('due', -DAY)];
			const pool = [
				row('typed-rested', ['due']),
				recognition('choice-hot', ['due'], { timesServed: 1, lastServedAt: NOW - DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual([
				'typed-rested',
				'choice-hot'
			]);
			// With one slot the fit never gets a look in.
			expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['typed-rested']);
		});

		it('prefers bearable material in the freshness filler too', () => {
			// Nothing due, so only the filler runs: the same "bearable first, then
			// the rest, each in its own order" rule, applied to a whole bucket.
			const items = [item('later', +5 * DAY)];
			const pool = [
				row('typed', ['later'], { generatedAt: NOW }),
				recognition('choice', ['later'], { generatedAt: NOW - 5 * DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['choice', 'typed']);
		});
	});

	it('excludes reported challenges', () => {
		const items = [item('due', -DAY)];
		const pool = [row('bad', ['due'], { reported: true }), row('good', ['due'])];

		expect(ids(planSession(pool, items, NOW))).toEqual(['good']);
	});

	it('excludes challenges whose words no longer exist', () => {
		const items = [item('kept', -DAY)];
		const pool = [
			row('orphan', ['deleted']),
			row('half-orphan', ['kept', 'deleted']),
			row('nothing', []),
			row('fine', ['kept'])
		];

		expect(ids(planSession(pool, items, NOW))).toEqual(['fine']);
	});

	it('gives each due word a second challenge before falling back to fresh filler', () => {
		const items = [item('due', -DAY), item('later', +DAY)];
		const pool = [
			row('due-1', ['due'], { generatedAt: NOW - 2 * DAY }),
			row('due-2', ['due'], { generatedAt: NOW - 3 * DAY }),
			row('filler', ['later'], { generatedAt: NOW })
		];

		expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['due-1', 'due-2']);
	});

	it('fills leftover slots with the newest never-served challenges', () => {
		const items = [item('due', -DAY), item('later', +DAY)];
		// Recognition rows throughout, and deliberately: these are fresh cards, so a
		// pool of `row`'s demand-2 typed translations would be uniformly *un*bearable
		// and the filler's partition would never be exercised at all — the ordering
		// below would hold for the wrong reason.
		const pool = [
			recognition('due-1', ['due']),
			recognition('fill-old', ['later'], { generatedAt: NOW - 5 * DAY }),
			recognition('fill-new', ['later'], { generatedAt: NOW }),
			recognition('fill-older', ['later'], { generatedAt: NOW - 9 * DAY }),
			recognition('fill-served', ['later'], { timesServed: 1, lastServedAt: NOW - 10 * DAY })
		];

		// Due first, then freshness newest-first, and only then the recyclables.
		expect(ids(planSession(pool, items, NOW, { target: 5 }))).toEqual([
			'due-1',
			'fill-new',
			'fill-old',
			'fill-older',
			'fill-served'
		]);
	});

	it('orders the filler by freshness alone, never by fit', () => {
		// A `fitRank` is a distance to *one word's* target, so between two words it
		// is noise. Ranking the heterogeneous filler by it let a stale row that
		// happens to sit near its own word's band centre jump a never-served row
		// from the batch the learner just paid for — and "the newest material
		// leads" quietly stopped being true.
		const items = [strongItem('strong', +DAY), item('weak', +2 * DAY)];
		// Two rows apiece for the walk to claim (it gives every word two passes),
		// so exactly one row per word is left for the filler to order. Identical
		// prompts within a word, so the walk's own fit preference has nothing to
		// say and takes them in plain freshness order.
		const strongRow = (id: string, over: Partial<ChallengeRow> = {}) =>
			row(id, ['strong'], { prompt: 'la cuenta', ...over });
		const weakRow = (id: string, over: Partial<ChallengeRow> = {}) =>
			recognition(id, ['weak'], { prompt: 'the bill', ...over });

		const pool = [
			strongRow('s1', { generatedAt: NOW }),
			strongRow('s2', { generatedAt: NOW - DAY }),
			weakRow('w1', { generatedAt: NOW }),
			weakRow('w2', { generatedAt: NOW - DAY }),
			// The filler's two candidates, both bearable and both rested. `stale` is
			// the better fit (a typed translation ~0.63 against a level-4 word's
			// 0.575 centre) but was served a fortnight ago; `fresh` is the worse fit
			// (a short multiple-choice ~0.01 against a level-1 word's 0.075) and has
			// never been served. Freshness decides, and only freshness.
			weakRow('fresh', { generatedAt: NOW - 2 * DAY }),
			strongRow('stale', { timesServed: 1, lastServedAt: NOW - 14 * DAY })
		];

		expect(ids(planSession(pool, items, NOW, { target: 6 }))).toEqual([
			's1',
			'w1',
			's2',
			'w2',
			'fresh',
			'stale'
		]);
	});

	it('never plans the same challenge twice, even across several due words', () => {
		const items = [item('a', -2 * DAY), item('b', -DAY)];
		const pool = [row('both', ['a', 'b']), row('just-b', ['b'])];

		const planned = ids(planSession(pool, items, NOW, { target: 4 }));
		expect(planned).toEqual(['both', 'just-b']);
		expect(new Set(planned).size).toBe(planned.length);
	});

	it('respects the target and the hard cap', () => {
		const items = [item('due', -DAY)];
		const pool = Array.from({ length: 40 }, (_, i) =>
			row(`c${String(i).padStart(2, '0')}`, ['due'], { generatedAt: NOW - i })
		);

		expect(planSession(pool, items, NOW)).toHaveLength(BATCH_TARGET);
		expect(planSession(pool, items, NOW, { target: 5 })).toHaveLength(5);
		// A target above the ceiling is clamped, not honoured.
		expect(planSession(pool, items, NOW, { target: 999 })).toHaveLength(SESSION_LENGTH);
		expect(planSession(pool, items, NOW, { target: 999, limit: 3 })).toHaveLength(3);
	});

	it('is deterministic and independent of pool order', () => {
		const items = [item('a', -2 * DAY), item('b', -DAY), item('c', +DAY)];
		const pool = [
			row('c1', ['a']),
			row('c2', ['b'], { timesServed: 1, lastServedAt: NOW - 9 * DAY }),
			row('c3', ['c'], { generatedAt: NOW }),
			row('c4', ['a'], { generatedAt: NOW - 4 * DAY })
		];

		const once = ids(planSession(pool, items, NOW));
		expect(ids(planSession(pool, items, NOW))).toEqual(once);
		expect(ids(planSession([...pool].reverse(), items, NOW))).toEqual(once);
	});

	it('hands back plain challenges, without the pool bookkeeping', () => {
		const planned = planSession(
			[row('c1', ['due'], { topic: 'at the market' })],
			[item('due', -DAY)],
			NOW
		);

		expect(planned[0]).not.toHaveProperty('timesServed');
		expect(planned[0]).not.toHaveProperty('lastServedAt');
		expect(planned[0]).not.toHaveProperty('generatedAt');
		expect(planned[0]).not.toHaveProperty('reported');
		expect(planned[0]).not.toHaveProperty('topic');
		expect(planned[0].id).toBe('c1');
	});

	it('is pure: it does not mutate the pool it is given', () => {
		const pool = [row('c1', ['due']), row('c2', ['due'], { generatedAt: NOW })];
		const snapshot = structuredClone(pool);

		planSession(pool, [item('due', -DAY)], NOW);

		expect(pool).toEqual(snapshot);
	});

	it('returns nothing when there is nothing playable', () => {
		expect(planSession([], [item('due', -DAY)], NOW)).toEqual([]);
		expect(planSession([row('c1', ['due'])], [], NOW)).toEqual([]);
	});

	describe('reaching past the schedule', () => {
		// The tail that replaced the old separate "extra practice" planner: once
		// the due words are paid off, the same walk carries on into words due
		// later, and the leftovers finally spend the rest gap. Early review is
		// native to FSRS — it simply banks a smaller stability gain.

		it('finds work when nothing is due and the whole pool is resting', () => {
			// The state the plan used to have nothing at all to say about, and the
			// reason "Start session" can now always be pressed.
			const items = [item('a', +2 * DAY), item('b', +5 * DAY)];
			const pool = [resting('ca', ['a'], DAY), resting('cb', ['b'], DAY)];

			expect(ids(planSession(pool, items, NOW))).toEqual(['ca', 'cb']);
		});

		it('walks words not yet due soonest-due first', () => {
			const items = [item('late', +5 * DAY), item('soon', +DAY), item('later', +10 * DAY)];
			const pool = [row('c-late', ['late']), row('c-soon', ['soon']), row('c-later', ['later'])];

			expect(ids(planSession(pool, items, NOW, { target: 3 }))).toEqual([
				'c-soon',
				'c-late',
				'c-later'
			]);
		});

		it('still pays off the schedule first', () => {
			const items = [item('overdue', -5 * DAY), item('ahead', +5 * DAY)];
			const pool = [row('c-ahead', ['ahead'], { generatedAt: NOW }), row('c-overdue', ['overdue'])];

			// The overdue word leads even though the other row is the fresher one:
			// reaching ahead is what happens after the schedule, never instead.
			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['c-overdue', 'c-ahead']);
		});

		it('gives a due word its second angle before a word that is not due gets its first', () => {
			const items = [item('due', -DAY), item('later', +DAY)];
			const pool = [
				row('due-1', ['due'], { generatedAt: NOW - 2 * DAY }),
				row('due-2', ['due'], { generatedAt: NOW - 3 * DAY }),
				row('ahead', ['later'], { generatedAt: NOW })
			];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['due-1', 'due-2']);
		});

		it('does not spend the rest gap in the walk for a word that is not due', () => {
			const items = [item('a', +DAY)];
			const pool = [
				resting('hot', ['a'], 60 * 60 * 1000),
				row('fresh', ['a']),
				resting('cooler', ['a'], 2 * DAY)
			];

			// Rested first in the walk; the two resting rows only arrive with the
			// last-resort filler, least recently served first.
			expect(ids(planSession(pool, items, NOW, { target: 3 }))).toEqual(['fresh', 'cooler', 'hot']);
		});

		it('fills leftover slots with rested material before resting material', () => {
			const items = [item('a', +DAY)];
			const pool = [
				row('r-new', ['a'], { generatedAt: NOW }),
				row('r-old', ['a'], { generatedAt: NOW - 5 * DAY }),
				resting('s-cool', ['a'], 2 * DAY),
				resting('s-hot', ['a'], 60 * 60 * 1000)
			];

			// Two passes take one rested row each, then the filler runs the same two
			// orders: rested leftovers, and only then anything inside its gap.
			expect(ids(planSession(pool, items, NOW, { target: 4 }))).toEqual([
				'r-new',
				'r-old',
				's-cool',
				's-hot'
			]);
		});

		it('never plays a reported row or one whose words are gone, resting or not', () => {
			const items = [item('a', +DAY)];
			const pool = [
				row('flagged', ['a'], { reported: true }),
				row('orphan', ['a', 'deleted']),
				row('itemless', []),
				row('flagged-hot', ['a'], { timesServed: 1, lastServedAt: NOW - DAY, reported: true }),
				row('fine', ['a'])
			];

			expect(ids(planSession(pool, items, NOW, { target: 5 }))).toEqual(['fine']);
		});

		it('prefers a bearable challenge for a word that is not due either', () => {
			// Reaching ahead is not asking to be over-faced: a word still at
			// strength 0 gets the recognition row first here too, and the production
			// one right after it rather than never.
			const items = [item('a', +DAY)];
			const pool = [
				row('typed', ['a'], { generatedAt: NOW }),
				recognition('choice', ['a'], { generatedAt: NOW - 5 * DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['choice', 'typed']);
			expect(ids(planSession(pool, [strongItem('a', +DAY)], NOW, { target: 2 }))).toEqual([
				'typed',
				'choice'
			]);
		});

		it('walks words past the schedule regardless of review history', () => {
			const reviewed = [{ at: NOW - DAY, grade: 3 }];
			const items = [item('never', +DAY), item('seen', +2 * DAY, reviewed)];
			const pool = [resting('c-never', ['never'], DAY), resting('c-seen', ['seen'], DAY)];

			// Soonest-due first, and that is the only thing that orders them.
			expect(ids(planSession(pool, items, NOW, { target: 4 }))).toEqual(['c-never', 'c-seen']);
		});
	});

	describe('the whole vocabulary participates', () => {
		it('serves a never-reviewed word its due challenge like any other', () => {
			const items = [item('never', -DAY), item('seen', -DAY, [{ at: NOW - DAY, grade: 3 }])];
			const pool = [row('c-never', ['never']), row('c-seen', ['seen'])];

			expect(ids(planSession(pool, items, NOW)).sort()).toEqual(['c-never', 'c-seen']);
		});

		it('lets a never-reviewed word fill a leftover slot too', () => {
			const items = [item('due', -DAY, [{ at: NOW - DAY, grade: 3 }]), item('never', +DAY)];
			const pool = [row('due-1', ['due']), row('filler', ['never'], { generatedAt: NOW })];

			expect(ids(planSession(pool, items, NOW, { target: 2 }))).toEqual(['due-1', 'filler']);
		});

		it('still puts a due word ahead of a fresher challenge for one that is not', () => {
			const items = [item('due', -5 * DAY), item('fine', +5 * DAY)];
			const pool = [
				row('fresh', ['fine'], { generatedAt: NOW }),
				row('old-but-due', ['due'], { generatedAt: NOW - 30 * DAY })
			];

			expect(ids(planSession(pool, items, NOW, { target: 1 }))).toEqual(['old-but-due']);
		});
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
		// `knownTermLabels` needs it to tell two same-spelled cards apart in the
		// prompt; a word without one costs nothing for the field.
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

		// These cards are freshly created, so every word is still rung 1 and only
		// recognition kinds are wanted. `c` is not due — it rides along because a
		// top-up has no other source of vocabulary and must not come back empty
		// for a learner who is caught up.
		expect(wordsOf(plan)).toEqual(['b', 'a', 'c']);
		expect(plan.wants.map((w) => w.item.id)).toEqual(['b', 'b', 'a', 'a', 'c', 'c']);
		for (const want of plan.wants) {
			const id = want.item.id;
			expect(want.item).toEqual({ id, term: `term-${id}`, meaning: `meaning-${id}` });
			expect(want.difficulty).toBe(1);
		}
	});

	it('writes a reviewed word at a higher rung than a brand-new one', () => {
		const fresh = item('a', -DAY);
		const card = reviewCard(newCardState(NOW - 5 * DAY), Grade.Good, NOW - 5 * DAY);
		const reviewed: KnowledgeItem = {
			...item('b', -DAY),
			fsrsCard: { ...card, due: NOW - DAY }
		};

		const rungs = new Map(
			planRefill([], [fresh, reviewed], profile(), NOW).wants.map((w) => [w.item.id, w.difficulty])
		);
		expect(rungs.get('a')).toBe(1);
		expect(rungs.get('b')).toBeGreaterThan(1);
	});

	it('wants nothing for a word the pool already covers', () => {
		// Two rested recognition kinds about a new word: it has what a session
		// would serve it, so the brief is empty and the word is not in it.
		const pool = [recognition('r1', ['a']), production('r2', ['a'])];
		const plan = planRefill(pool, [item('a', -DAY)], profile(), NOW);

		expect(plan.wants).toEqual([]);
	});

	it('asks only for what a word is missing', () => {
		const pool = [recognition('r1', ['a'])];
		const plan = planRefill(pool, [item('a', -DAY)], profile(), NOW);

		expect(plan.wants).toHaveLength(1);
		expect(kindKey(plan.wants[0].kind)).not.toBe('recognize-mc');
		expect(wordsOf(plan)).toEqual(['a']);
	});

	it('honours maxItems', () => {
		const items = [item('a', -3 * DAY), item('b', -2 * DAY), item('c', -DAY)];
		const plan = planRefill([], items, profile(), NOW, { maxItems: 2 });

		expect(wordsOf(plan)).toEqual(['a', 'b']);
		expect(plan.wants).toHaveLength(4);
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

	it('still writes about a card that was just reviewed, as review-ahead', () => {
		// It is no longer due, and it is the only word there is. Excluding it would
		// hand the model an empty brief; a challenge about it is graded normally
		// when it is played, just for a smaller stability gain.
		const reviewed = item('a', -DAY);
		const plan = planRefill(
			[],
			[{ ...reviewed, fsrsCard: reviewCard(reviewed.fsrsCard as never, Grade.Easy, NOW) }],
			profile(),
			NOW
		);
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
	it('runs in mock mode under node (no API key)', () => {
		expect(isMockMode()).toBe(true);
	});

	it('produces a playable batch that introduces no vocabulary', async () => {
		const items = [item('a', -2 * DAY), item('b', -DAY)];
		const plan = planRefill([], items, profile(), NOW);
		const batch = await getBatch(plan);

		expect(batch.challenges.length).toBeGreaterThanOrEqual(5);
		// The invariant the whole generation path now rests on: a lesson is
		// challenges and nothing else, so `generateChallenges` has no item write to
		// make and the collection cannot grow behind the learner's back.
		expect(batch).not.toHaveProperty('newItems');

		// Every challenge stands on a word we actually sent.
		const known = new Set(items.map((i) => i.id));
		for (const challenge of batch.challenges) {
			expect(challenge.itemIds.length).toBeGreaterThan(0);
			for (const id of challenge.itemIds) expect(known.has(id)).toBe(true);
		}

		// Mock mode spends nothing.
		expect(batch.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
	});

	it('has nothing to build from when the learner has no words', async () => {
		const batch = await getBatch(planRefill([], [], profile(), NOW));
		expect(batch.challenges).toEqual([]);
	});

	it('walks the same progress steps as the real path, instantly', async () => {
		const steps: ProgressStep[] = [];
		await getBatch(planRefill([], [], profile(), NOW), { onProgress: (s) => steps.push(s) });
		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
	});

	it('covers every gradeable challenge type the session renders', async () => {
		const items = [item('a', -2 * DAY), item('b', -DAY)];
		const plan = planRefill([], items, profile(), NOW);
		const batch = await getBatch(plan);
		const types = new Set(batch.challenges.map((c) => c.type));

		expect(types.has('multiple-choice')).toBe(true);
		expect(types.has('cloze')).toBe(true);
		expect(types.has('typed-translation')).toBe(true);
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
		const planned = planSession(pool, items, NOW);
		const queue = interleaveMatchRounds(planned, items, NOW);

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

	it('plays a flawless session: the whole plan and 3 free rounds', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, () => 'correct');

		// A BATCH_TARGET-sized plan, played to the end: the session is sized by
		// what was planned, and nothing may be left over at the end of it.
		expect(run.llmAnswered).toBe(BATCH_TARGET);
		expect(run.unplayed).toBe(0);
		expect(run.matchRounds).toBe(3); // after the 4th, 8th and 12th answer
		expect(run.answers).toHaveLength(BATCH_TARGET + 3);
		expect(run.summary.accuracy).toBe(1);
		expect(run.summary.correct).toBe(BATCH_TARGET + 3);
	});

	it('counts a single miss without disturbing the rest of the session', async () => {
		const known = Array.from({ length: 7 }, (_, i) => item(`k${i}`, -DAY));
		const run = await playSession(known, (_challenge, index) =>
			index === 4 ? 'wrong' : 'correct'
		);

		expect(run.llmAnswered).toBe(BATCH_TARGET);
		expect(run.summary.wrong).toBe(1);
		expect(run.summary.answered).toBe(BATCH_TARGET + 3);
	});

	it('ends gracefully when the plan is shorter than a full session', async () => {
		// A tiny batch: mock mode still returns its canned challenges.
		const plan = planRefill([], [], profile(), NOW);
		const batch = await getBatch(plan);
		expect(batch.challenges.length).toBeLessThan(SESSION_LENGTH);

		const run = await playSession([], () => 'correct');
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
