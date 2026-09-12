/**
 * The locally-built `match-pairs` round: sizing, collision handling and the
 * shapes it refuses. Moved here with the builder, out of `$lib/llm`.
 *
 * The schema check goes through `$lib/llm/schemas` on purpose — the round is
 * played like any other stored challenge, so it has to satisfy the same union
 * the real batch parses into. That import is the test's, not the builder's; the
 * builder itself never touches `$lib/llm`.
 */

import { describe, expect, it } from 'vitest';
import { challengeSchema } from '$lib/llm/schemas';
import type { Challenge, KnowledgeItem } from '$lib/types';
import { makeMatchPairsChallenge } from './match-pairs';

describe('makeMatchPairsChallenge', () => {
	const items: KnowledgeItem[] = ['perro', 'gato', 'casa', 'pan', 'agua'].map((term, i) => ({
		id: `k${i}`,
		kind: 'vocab',
		term,
		meaning: `meaning-${i}`,
		fsrsCard: null,
		introducedAt: 0,
		history: []
	}));

	it('returns undefined below four items', () => {
		expect(makeMatchPairsChallenge(items.slice(0, 3))).toBeUndefined();
		expect(makeMatchPairsChallenge([])).toBeUndefined();
	});

	it('builds a valid four-to-five pair challenge with no tokens spent', () => {
		const challenge = makeMatchPairsChallenge(items, () => 0.5);
		expect(challenge).toBeDefined();
		expect(challenge?.type).toBe('match-pairs');
		expect(challengeSchema.safeParse(challenge).success).toBe(true);

		const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
		expect(pairs.length).toBeGreaterThanOrEqual(4);
		expect(pairs.length).toBeLessThanOrEqual(5);
		expect(challenge?.itemIds).toHaveLength(pairs.length);
		for (const pair of pairs) {
			const source = items.find((i) => i.term === pair.a);
			expect(source?.meaning).toBe(pair.b);
		}
	});

	it('ignores items missing a term or meaning', () => {
		const broken = [...items.slice(0, 3), { ...items[3], meaning: '  ' }];
		expect(makeMatchPairsChallenge(broken)).toBeUndefined();
	});

	it('carries the term romanization as aRom when the item has one', () => {
		const zhItems: KnowledgeItem[] = [
			{ term: '菜单', meaning: 'the menu', romanization: 'càidān' },
			{ term: '买单', meaning: 'to pay the bill', romanization: 'mǎidān' },
			{ term: '筷子', meaning: 'chopsticks', romanization: 'kuàizi' },
			{ term: '茶', meaning: 'tea', romanization: 'chá' }
		].map((partial, i) => ({
			id: `z${i}`,
			kind: 'vocab' as const,
			fsrsCard: null,
			introducedAt: 0,
			history: [],
			...partial
		}));

		const challenge = makeMatchPairsChallenge(zhItems, () => 0.5);
		expect(challengeSchema.safeParse(challenge).success).toBe(true);
		const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
		for (const pair of pairs) {
			expect(pair.aRom).toBe(zhItems.find((i) => i.term === pair.a)?.romanization);
			// `b` is already in the native language, so it never gets a reading.
			expect('bRom' in pair).toBe(false);
		}
		// Latin-script items add no romanization keys at all.
		expect(JSON.stringify(makeMatchPairsChallenge(items, () => 0.5))).not.toContain('Rom');
	});

	describe('duplicate tile labels', () => {
		/** Two identical tiles are unplayable: the learner has to guess which twin is which. */
		const withMeaningClash: KnowledgeItem[] = [
			...items,
			{
				id: 'k5',
				kind: 'vocab',
				term: 'pronto',
				// A synonym of k0: distinct term, same meaning tile.
				meaning: 'meaning-0',
				fsrsCard: null,
				introducedAt: 0,
				history: []
			}
		];

		it('never emits the same label twice on either side', () => {
			for (let seed = 0; seed < 20; seed++) {
				const challenge = makeMatchPairsChallenge(withMeaningClash, () => seed / 20);
				const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
				expect(pairs.length).toBeGreaterThanOrEqual(4);
				expect(new Set(pairs.map((p) => p.a)).size).toBe(pairs.length);
				expect(new Set(pairs.map((p) => p.b)).size).toBe(pairs.length);
			}
		});

		it('matches collisions case- and whitespace-insensitively', () => {
			const shouty = [
				...items.slice(0, 5),
				{ ...items[0], id: 'k9', term: '  PERRO  ', meaning: 'the hound' }
			];
			for (let seed = 0; seed < 20; seed++) {
				const challenge = makeMatchPairsChallenge(shouty, () => seed / 20);
				const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
				const keys = pairs.map((p) => p.a.trim().toLowerCase());
				expect(new Set(keys).size).toBe(pairs.length);
			}
		});

		it('returns undefined when excluding the collision leaves fewer than four items', () => {
			const four = [
				...items.slice(0, 3),
				{ ...items[3], id: 'k9', term: 'temprano', meaning: 'meaning-0' }
			];
			expect(makeMatchPairsChallenge(four, () => 0.5)).toBeUndefined();
		});
	});

	/**
	 * The free round is sized off the same 1-5 ladder every paid type is written
	 * to. These pin the ladder itself, its bounds against the stored side's
	 * `FEWEST_PAIRS`/`MOST_PAIRS` scale, and the two ways a short vocabulary can
	 * land.
	 */
	describe('ladder sizing', () => {
		const rungs = [1, 2, 3, 4, 5] as const;

		/** Twelve collision-free words, so every rung can be satisfied outright. */
		const plenty: KnowledgeItem[] = Array.from({ length: 12 }, (_, i) => ({
			id: `p${i}`,
			kind: 'vocab',
			term: `term-${i}`,
			meaning: `meaning-${i}`,
			fsrsCard: null,
			introducedAt: 0,
			history: []
		}));

		const pairCount = (challenge: Challenge | undefined) =>
			challenge?.type === 'match-pairs' ? challenge.pairs.length : undefined;

		it('never falls as the rung rises, and stays inside the stored 2..6 scale', () => {
			const counts = rungs.map((rung) =>
				pairCount(makeMatchPairsChallenge(plenty, () => 0.5, { difficulty: rung }))
			);

			expect(counts).toEqual([...counts].sort((a, b) => (a ?? 0) - (b ?? 0)));
			for (const count of counts) {
				expect(count).toBeGreaterThanOrEqual(2);
				expect(count).toBeLessThanOrEqual(6);
			}
			// The whole ladder is exercised: the top rung asks for more than the
			// bottom one, or sizing would be a no-op that still typechecked.
			expect(counts.at(-1)).toBeGreaterThan(counts[0] ?? 0);
		});

		it('honours each rung exactly when there are words enough', () => {
			const counts = rungs.map((rung) =>
				pairCount(makeMatchPairsChallenge(plenty, () => 0.5, { difficulty: rung }))
			);
			expect(counts).toEqual([3, 4, 5, 6, 6]);
		});

		it('builds the smaller round rather than declining when words run short', () => {
			// Rung 5 wants six; three collision-free words is still a playable round
			// and still above the ladder's own floor.
			const three = plenty.slice(0, 3);
			expect(pairCount(makeMatchPairsChallenge(three, () => 0.5, { difficulty: 5 }))).toBe(3);
			expect(
				pairCount(makeMatchPairsChallenge(plenty.slice(0, 5), () => 0.5, { difficulty: 4 }))
			).toBe(5);
		});

		it('declines below the smallest round the ladder can ask for', () => {
			expect(
				makeMatchPairsChallenge(plenty.slice(0, 2), () => 0.5, { difficulty: 1 })
			).toBeUndefined();
			// Collisions are resolved before the floor is applied, exactly as they
			// are for an unsized round.
			const clashing = [...plenty.slice(0, 2), { ...plenty[2], meaning: plenty[0].meaning }];
			expect(makeMatchPairsChallenge(clashing, () => 0.5, { difficulty: 3 })).toBeUndefined();
		});

		it('leaves an unsized round exactly as it was', () => {
			// No `difficulty`: the four-or-five draw, and the old four-item floor.
			for (let seed = 0; seed < 20; seed++) {
				const count = pairCount(makeMatchPairsChallenge(plenty, () => seed / 20));
				expect(count).toBeGreaterThanOrEqual(4);
				expect(count).toBeLessThanOrEqual(5);
			}
			expect(makeMatchPairsChallenge(plenty.slice(0, 3), () => 0.5)).toBeUndefined();
		});
	});
});
