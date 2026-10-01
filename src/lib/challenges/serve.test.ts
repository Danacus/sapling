/**
 * Serving through the wasm seam. The help levels and their cases are Rust's
 * (`crates/sapling-challenges`' `serve.rs`, `help.rs` and `fits.rs`); this pins
 * what the TypeScript side adds — the readings arriving as a `Map` — and the
 * bare-render defaults, which are this side's.
 */

import { describe, expect, it } from 'vitest';
import type { ClozeChallenge, KnowledgeItem, WordOrderChallenge } from '$lib/types';
import {
	ALL_READINGS,
	maturityOf,
	presentationFor,
	resolvedPresentation,
	visibleBank,
	visibleTiles
} from './serve';

function item(id: string, strength: number): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: id,
		meaning: `meaning of ${id}`,
		fsrsCard: null,
		srs: { due: 0, retrievability: 1, strength },
		introducedAt: 0,
		history: []
	};
}

const cloze: ClozeChallenge = {
	id: 'c1',
	type: 'cloze',
	direction: 'toTarget',
	sentence: 'Yo ___ un libro.',
	acceptedAnswers: ['leo'],
	wordBank: ['d1', 'leo', 'd2', 'd3', 'd4', 'd5'],
	translationHint: 'I read a book.',
	itemIds: ['w']
};

const wordOrder: WordOrderChallenge = {
	id: 'w1',
	type: 'word-order',
	direction: 'toTarget',
	tiles: ['yo', 'd1', 'yo', 'leo', 'd2'],
	answerTokens: ['yo', 'yo', 'leo'],
	answer: 'yo yo leo',
	itemIds: ['w']
};

describe('presentationFor', () => {
	it('shows the help level serving picked, and hands the readings back as a Map', () => {
		expect(presentationFor(cloze, 'pick-4')).toEqual({
			showHint: true,
			bankSize: 4,
			distractorTiles: 0,
			readings: ALL_READINGS,
			listening: false,
			shown: 'pick-4'
		});
		const typed = presentationFor(cloze, 'typed-hidden');
		expect(typed.showHint).toBe(false);
		expect(typed.bankSize).toBe(0);
		expect(typed.readings.byTerm).toBeInstanceOf(Map);
		expect(typed.readings.sentence).toBe(false);
	});

	it('shows a help level this build does not know at the easiest step', () => {
		expect(presentationFor(cloze, 'pick-9').shown).toBe('pick-4');
	});
});

describe('visible entries', () => {
	it('keep the answers in place and take distractors in stored order', () => {
		expect(visibleBank(cloze, 3)).toEqual([0, 1, 2]);
		expect(visibleTiles(wordOrder, 1)).toEqual([0, 1, 2, 3]);
	});
});

describe('maturityOf', () => {
	it('buckets a word by its strength', () => {
		expect(maturityOf(item('a', 0))).toBe('new');
		expect(maturityOf(item('a', 0.32))).toBe('young');
		expect(maturityOf(item('a', 0.9))).toBe('solid');
	});
});

describe('resolvedPresentation', () => {
	it('shows everything stored when nothing was served', () => {
		expect(resolvedPresentation(cloze)).toEqual({
			showHint: true,
			bankSize: 6,
			distractorTiles: 0,
			readings: ALL_READINGS,
			listening: false
		});
		expect(resolvedPresentation(wordOrder).distractorTiles).toBe(2);
	});

	it('passes a supplied field through and fills only what a partial leaves out', () => {
		const supplied = {
			showHint: false,
			bankSize: 2,
			distractorTiles: 0,
			readings: { sentence: false, byTerm: new Map([['w', true]]) },
			listening: false
		};
		expect(resolvedPresentation(cloze, supplied)).toEqual(supplied);
		expect(resolvedPresentation(cloze, { showHint: false })).toEqual({
			showHint: false,
			bankSize: 6,
			distractorTiles: 0,
			readings: ALL_READINGS,
			listening: false
		});
	});
});
