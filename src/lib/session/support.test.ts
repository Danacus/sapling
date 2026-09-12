import { describe, expect, it } from 'vitest';
import type {
	Challenge,
	ClozeChallenge,
	KnowledgeItem,
	MultiClozeChallenge,
	WordOrderChallenge
} from '$lib/types';
import {
	CLOZE_BANK_LADDER,
	HINT_CEILING_LEVEL,
	MULTI_CLOZE_BANK_LADDER,
	WORD_ORDER_DISTRACTOR_LADDER,
	bankSizeFor,
	distractorTilesFor,
	presentationFor,
	showNativeHint,
	visibleBank,
	visibleTiles
} from './support';
import { LEVEL_BANDS, levelForStrength, type DifficultyLevel } from './progression';

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

/** One word as a read returns it: the strength derived, the card left opaque. */
function item(id: string, strength: number): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: id,
		meaning: `meaning of ${id}`,
		fsrsCard: null,
		srs: { due: NOW, retrievability: 1, strength },
		introducedAt: NOW,
		history: []
	};
}

/** A strength squarely inside a rung's band, so the rung is unambiguous. */
function strengthAt(level: DifficultyLevel): number {
	const [start, end] = LEVEL_BANDS[level];
	return (start + end) / 2;
}

function cloze(itemIds: string[], wordBank: string[]): ClozeChallenge {
	return {
		id: 'c1',
		type: 'cloze',
		direction: 'toTarget',
		sentence: 'Yo ___ un libro.',
		acceptedAnswers: [wordBank[0] ?? 'leo'],
		wordBank,
		itemIds
	};
}

function multiCloze(itemIds: string[], answers: string[], wordBank: string[]): MultiClozeChallenge {
	return {
		id: 'm1',
		type: 'multi-cloze',
		direction: 'toTarget',
		passage: '___1___ leo un libro.',
		gaps: itemIds.map((itemId, index) => ({
			itemId,
			acceptedAnswers: [answers[index] ?? answers[0] ?? '']
		})),
		wordBank,
		itemIds
	};
}

function wordOrder(itemIds: string[], answerTokens: string[], tiles: string[]): WordOrderChallenge {
	return {
		id: 'w1',
		type: 'word-order',
		direction: 'toTarget',
		tiles,
		answerTokens,
		answer: answerTokens.join(' '),
		itemIds
	};
}

describe('bankSizeFor', () => {
	const bigBank = ['leo', 'como', 'bebo', 'corro', 'salto', 'duermo'];

	it('sizes a cloze bank off CLOZE_BANK_LADDER', () => {
		for (const level of [1, 2, 3, 4, 5] as const) {
			const challenge = cloze(['w'], bigBank);
			const items = [item('w', strengthAt(level))];
			expect(bankSizeFor(challenge, items), `rung ${level}`).toBe(CLOZE_BANK_LADDER[level - 1]);
		}
	});

	it('sizes a multi-cloze bank off MULTI_CLOZE_BANK_LADDER', () => {
		const bigMultiBank = [...bigBank, 'canto', 'nado', 'salgo'];
		for (const level of [1, 2, 3, 4, 5] as const) {
			const challenge = multiCloze(['w'], ['leo'], bigMultiBank);
			const items = [item('w', strengthAt(level))];
			expect(bankSizeFor(challenge, items), `rung ${level}`).toBe(
				MULTI_CLOZE_BANK_LADDER[level - 1]
			);
		}
	});

	it('never exceeds the stored bank, up to the rung where the ladder stops asking for one', () => {
		// Rung 4 still wants six; a two-entry stored bank caps it there.
		const challenge = cloze(['w'], ['leo', 'como']);
		const items = [item('w', strengthAt(4))];
		expect(bankSizeFor(challenge, items)).toBe(2);
	});

	it('shows no bank at all at the top rung: cued recall, typed', () => {
		// The rung `$lib/session/progression`'s `servedDemand` treats as free
		// production even though the row is stored (and demand-planned) as a
		// banked, constrained-production cloze.
		const challenge = cloze(['w'], ['leo', 'como', 'bebo', 'corro', 'salto', 'duermo']);
		const items = [item('w', strengthAt(5))];
		expect(bankSizeFor(challenge, items)).toBe(0);
	});

	it('gives the smallest (most supported) size when an item does not resolve', () => {
		const challenge = cloze(['gone'], ['leo', 'como', 'bebo']);
		expect(bankSizeFor(challenge, [])).toBe(CLOZE_BANK_LADDER[0]);
	});

	it('gives the smallest size when the challenge cites no items at all', () => {
		const challenge = cloze([], ['leo', 'como', 'bebo']);
		expect(bankSizeFor(challenge, [item('w', strengthAt(5))])).toBe(CLOZE_BANK_LADDER[0]);
	});

	it('is decided by the weakest word the challenge exercises', () => {
		const items = [item('owned', strengthAt(5)), item('new', strengthAt(1))];
		const challenge = multiCloze(['owned', 'new'], ['leo', 'como'], [...'abcdefghi']);
		expect(bankSizeFor(challenge, items)).toBe(MULTI_CLOZE_BANK_LADDER[0]);
	});
});

describe('distractorTilesFor', () => {
	const answerTokens = ['Yo', 'leo', 'un', 'libro.'];
	const bigTray = [...answerTokens, 'd1', 'd2', 'd3'];

	it('sizes the extra tiles off WORD_ORDER_DISTRACTOR_LADDER', () => {
		for (const level of [1, 2, 3, 4, 5] as const) {
			const challenge = wordOrder(['w'], answerTokens, bigTray);
			const items = [item('w', strengthAt(level))];
			expect(distractorTilesFor(challenge, items), `rung ${level}`).toBe(
				WORD_ORDER_DISTRACTOR_LADDER[level - 1]
			);
		}
	});

	it('never exceeds the stored distractors, however high the rung', () => {
		const challenge = wordOrder(['w'], answerTokens, [...answerTokens, 'd1']);
		const items = [item('w', strengthAt(5))];
		expect(distractorTilesFor(challenge, items)).toBe(1);
	});

	it('gives the smallest size when an item does not resolve', () => {
		const challenge = wordOrder(['gone'], answerTokens, bigTray);
		expect(distractorTilesFor(challenge, [])).toBe(WORD_ORDER_DISTRACTOR_LADDER[0]);
	});
});

describe('visibleBank', () => {
	it('always keeps the answer, wherever it sits in stored order', () => {
		const challenge = cloze(['w'], ['d1', 'leo', 'd2', 'd3', 'd4', 'd5']);
		expect(visibleBank(challenge, 3)).toEqual([0, 1, 2]);
	});

	it('grows by taking the next stored distractor, never reshuffling', () => {
		const challenge = cloze(['w'], ['d1', 'leo', 'd2', 'd3', 'd4', 'd5']);
		expect(visibleBank(challenge, 4)).toEqual([0, 1, 2, 3]);
	});

	it('caps at the stored bank length', () => {
		const challenge = cloze(['w'], ['leo', 'd1']);
		expect(visibleBank(challenge, 6)).toEqual([0, 1]);
	});

	it('never drops below every answer, even if asked for fewer', () => {
		const challenge = multiCloze(['a', 'b'], ['x', 'y'], ['d1', 'x', 'd2', 'y', 'd3']);
		// Two answers; asking for one still returns both.
		expect(visibleBank(challenge, 1)).toEqual([1, 3]);
	});

	it('is empty when the row has no bank at all (a typed cloze)', () => {
		const challenge: ClozeChallenge = {
			id: 'c2',
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Yo ___ un libro.',
			acceptedAnswers: ['leo'],
			itemIds: ['w']
		};
		expect(visibleBank(challenge, 3)).toEqual([]);
	});
});

describe('visibleTiles', () => {
	it('always keeps every sentence tile, in stored position', () => {
		const answerTokens = ['yo', 'yo', 'leo'];
		const tiles = ['yo', 'd1', 'yo', 'leo', 'd2'];
		const challenge = wordOrder(['w'], answerTokens, tiles);
		expect(visibleTiles(challenge, 0)).toEqual([0, 2, 3]);
	});

	it('respects tile multiplicity: a repeated word is not read as one big supply', () => {
		const answerTokens = ['yo', 'yo', 'leo'];
		const tiles = ['yo', 'd1', 'yo', 'leo', 'd2'];
		const challenge = wordOrder(['w'], answerTokens, tiles);
		// One distractor beyond the sentence's own two "yo" tiles.
		expect(visibleTiles(challenge, 1)).toEqual([0, 1, 2, 3]);
	});

	it('caps at the stored tray length', () => {
		const answerTokens = ['Yo', 'leo'];
		const tiles = [...answerTokens, 'd1'];
		const challenge = wordOrder(['w'], answerTokens, tiles);
		expect(visibleTiles(challenge, 5)).toEqual([0, 1, 2]);
	});
});

describe('showNativeHint', () => {
	function hintedCloze(itemIds: string[]): Challenge {
		return {
			id: 'c1',
			type: 'cloze',
			direction: 'toTarget',
			sentence: '我们想___。',
			acceptedAnswers: ['买单'],
			translationHint: 'We would like to pay the bill.',
			itemIds
		};
	}

	it('shows the line on the two early rungs', () => {
		for (const level of [1, 2] as const) {
			expect(
				showNativeHint(hintedCloze(['w']), [item('w', strengthAt(level))]),
				`rung ${level}`
			).toBe(true);
		}
	});

	it('hides the line from rung 3 up', () => {
		for (const level of [3, 4, 5] as const) {
			expect(
				showNativeHint(hintedCloze(['w']), [item('w', strengthAt(level))]),
				`rung ${level}`
			).toBe(false);
		}
	});

	it('is a step at the ceiling rung, inclusive', () => {
		// The band boundary is the floor of the next rung, so a word sitting
		// exactly on it has already left the ceiling rung.
		const [, ceilingEnd] = LEVEL_BANDS[HINT_CEILING_LEVEL];
		expect(levelForStrength(ceilingEnd)).toBe(HINT_CEILING_LEVEL + 1);
		expect(showNativeHint(hintedCloze(['w']), [item('w', ceilingEnd - 1e-9)])).toBe(true);
		expect(showNativeHint(hintedCloze(['w']), [item('w', ceilingEnd)])).toBe(false);
	});

	it('is decided by the weakest word the challenge exercises', () => {
		const items = [item('owned', strengthAt(5)), item('new', strengthAt(1))];
		expect(showNativeHint(hintedCloze(['owned', 'new']), items)).toBe(true);
		expect(showNativeHint(hintedCloze(['owned']), items)).toBe(false);
	});

	it('shows the line when an item no longer resolves: an unknown word is the weakest', () => {
		expect(showNativeHint(hintedCloze(['owned', 'gone']), [item('owned', strengthAt(5))])).toBe(
			true
		);
	});

	it('shows the line when the challenge cites no items at all', () => {
		expect(showNativeHint(hintedCloze([]), [item('owned', strengthAt(5))])).toBe(true);
	});

	it('is deterministic: the same inputs answer the same every time', () => {
		const items = [item('w', strengthAt(2))];
		const answers = new Set(
			Array.from({ length: 20 }, () => showNativeHint(hintedCloze(['w']), items))
		);
		expect(answers.size).toBe(1);
	});
});

describe('presentationFor', () => {
	it('folds the hint, bank size and distractor-tile count into one object', () => {
		const items = [item('w', strengthAt(1))];
		const challenge = cloze(['w'], ['leo', 'como', 'bebo', 'corro', 'salto', 'duermo']);
		expect(presentationFor(challenge, items)).toEqual({
			showHint: true,
			bankSize: CLOZE_BANK_LADDER[0],
			distractorTiles: 0
		});
	});

	it('reads the word-order ladder for a word-order challenge, and no bank', () => {
		const items = [item('w', strengthAt(2))];
		const answerTokens = ['Yo', 'leo', 'un', 'libro.'];
		const challenge = wordOrder(['w'], answerTokens, [...answerTokens, 'd1', 'd2', 'd3']);
		expect(presentationFor(challenge, items)).toEqual({
			showHint: true,
			bankSize: 0,
			distractorTiles: WORD_ORDER_DISTRACTOR_LADDER[1]
		});
	});

	it('gives a type with neither a bank nor a tray zeros for both, harmlessly', () => {
		const items = [item('w', strengthAt(1))];
		const challenge: Challenge = {
			id: 'm1',
			type: 'multiple-choice',
			direction: 'toNative',
			prompt: 'el perro',
			options: ['the dog', 'the cat', 'the bread', 'the house'],
			correctIndex: 0,
			itemIds: ['w']
		};
		expect(presentationFor(challenge, items)).toEqual({
			showHint: true,
			bankSize: 0,
			distractorTiles: 0
		});
	});
});
