/**
 * Serving through the wasm seam. The ladders and their cases are Rust's
 * (`crates/sapling-challenges`' `serve.rs` and `ladder.rs`); this pins what
 * the TypeScript side adds — the readings arriving as a `Map`, a seed
 * replaying them — and the bare-render defaults, which are this side's.
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
	it('sizes support off the weakest word and hands the readings back as a Map', () => {
		const fresh = presentationFor(cloze, [item('w', 0)], { romanizationMode: 'on' });
		expect(fresh).toEqual({
			showHint: true,
			bankSize: 3,
			distractorTiles: 0,
			readings: ALL_READINGS,
			listening: false,
			shown: 'pick-4'
		});

		const owned = presentationFor(cloze, [item('w', 0.9)], {
			romanizationMode: 'adaptive',
			seed: 7
		});
		expect(owned.showHint).toBe(false);
		expect(owned.bankSize).toBe(0);
		expect(owned.readings.byTerm).toBeInstanceOf(Map);
		expect(owned.readings.byTerm.get('w')).toBe(false);
	});

	it('replays its reading rolls from a seed', () => {
		const words = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id, 0.6));
		const roll = (seed: number) =>
			presentationFor({ ...cloze, itemIds: ['a'] }, words, { romanizationMode: 'adaptive', seed })
				.readings;
		expect(roll(3)).toEqual(roll(3));
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
