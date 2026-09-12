import { describe, expect, it } from 'vitest';
import type { Challenge, KnowledgeItem } from '$lib/types';
import { HINT_CEILING_LEVEL, showNativeHint } from './hints';
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

function cloze(itemIds: string[]): Challenge {
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

/** A strength squarely inside a rung's band, so the rung is unambiguous. */
function strengthAt(level: DifficultyLevel): number {
	const [start, end] = LEVEL_BANDS[level];
	return (start + end) / 2;
}

describe('showNativeHint', () => {
	it('shows the line on the two early rungs', () => {
		for (const level of [1, 2] as const) {
			expect(showNativeHint(cloze(['w']), [item('w', strengthAt(level))]), `rung ${level}`).toBe(
				true
			);
		}
	});

	it('hides the line from rung 3 up', () => {
		for (const level of [3, 4, 5] as const) {
			expect(showNativeHint(cloze(['w']), [item('w', strengthAt(level))]), `rung ${level}`).toBe(
				false
			);
		}
	});

	it('is a step at the ceiling rung, inclusive', () => {
		// The band boundary is the floor of the next rung, so a word sitting
		// exactly on it has already left the ceiling rung.
		const [, ceilingEnd] = LEVEL_BANDS[HINT_CEILING_LEVEL];
		expect(levelForStrength(ceilingEnd)).toBe(HINT_CEILING_LEVEL + 1);
		expect(showNativeHint(cloze(['w']), [item('w', ceilingEnd - 1e-9)])).toBe(true);
		expect(showNativeHint(cloze(['w']), [item('w', ceilingEnd)])).toBe(false);
	});

	it('is decided by the weakest word the challenge exercises', () => {
		const items = [item('owned', strengthAt(5)), item('new', strengthAt(1))];
		expect(showNativeHint(cloze(['owned', 'new']), items)).toBe(true);
		expect(showNativeHint(cloze(['owned']), items)).toBe(false);
	});

	it('shows the line when an item no longer resolves: an unknown word is the weakest', () => {
		expect(showNativeHint(cloze(['owned', 'gone']), [item('owned', strengthAt(5))])).toBe(true);
	});

	it('shows the line when the challenge cites no items at all', () => {
		expect(showNativeHint(cloze([]), [item('owned', strengthAt(5))])).toBe(true);
	});

	it('is deterministic: the same inputs answer the same every time', () => {
		const items = [item('w', strengthAt(2))];
		const answers = new Set(Array.from({ length: 20 }, () => showNativeHint(cloze(['w']), items)));
		expect(answers.size).toBe(1);
	});
});
