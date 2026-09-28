import { describe, expect, it } from 'vitest';
import type { RomanizedToken } from '$lib/romanize';
import { applyPlan, readingSlot } from './readings';
import type { ReadingPlan } from './serve';

describe('applyPlan', () => {
	const tokens: RomanizedToken[] = [
		{ text: '我', reading: 'wǒ' },
		{ text: '喜欢', reading: 'xǐ huān' },
		{ text: '___', reading: null },
		{ text: '。', reading: null }
	];
	const plan = (sentence: boolean, byTerm: [string, boolean][] = []): ReadingPlan => ({
		sentence,
		byTerm: new Map(byTerm)
	});

	it('keeps every reading when the whole sentence shows', () => {
		expect(applyPlan(tokens, plan(true))).toEqual(tokens);
	});

	it('drops every reading when the whole sentence hides', () => {
		expect(applyPlan(tokens, plan(false)).map((token) => token.reading)).toEqual([
			null,
			null,
			null,
			null
		]);
	});

	it('lets a tracked term overrule the sentence in both directions', () => {
		const hidden = applyPlan(tokens, plan(true, [['喜欢', false]]));
		expect(hidden.map((token) => token.reading)).toEqual(['wǒ', null, null, null]);

		const shown = applyPlan(tokens, plan(false, [['喜欢', true]]));
		expect(shown.map((token) => token.reading)).toEqual([null, 'xǐ huān', null, null]);
	});

	it('never invents a reading for a token that had none', () => {
		const gap = [{ text: '___', reading: null }];
		expect(applyPlan(gap, plan(true, [['___', true]]))).toEqual(gap);
	});

	it('does not mutate the tokens it was given', () => {
		const input: RomanizedToken[] = [{ text: '猫', reading: 'māo' }];
		applyPlan(input, plan(false));
		expect(input[0].reading).toBe('māo');
	});
});

describe('readingSlot', () => {
	/** `perro` is hidden by its own per-word roll; the sentence roll is on. */
	const readings: ReadingPlan = { sentence: true, byTerm: new Map([['perro', false]]) };
	const tokenize = (text: string): RomanizedToken[] => [{ text, reading: 'perro-rom' }];

	it('returns null tokens with no local romanizer, and the stored reading otherwise', () => {
		const slot = readingSlot(null, readings, 'gato', 'gato-rom');
		expect(slot.tokens).toBeNull();
		expect(slot.reading).toBe('gato-rom');
	});

	it('takes tokens from the romanizer with the plan applied', () => {
		expect(readingSlot(tokenize, readings, 'perro', 'perro-rom').tokens).toEqual([
			{ text: 'perro', reading: null }
		]);
	});

	it('gates a tracked term on its own roll, even where the sentence roll would show it', () => {
		expect(readingSlot(null, readings, 'perro', 'perro-rom').reading).toBe('');
	});

	it('hides a non-term too when the sentence roll is off', () => {
		const hidden: ReadingPlan = { sentence: false, byTerm: new Map() };
		expect(readingSlot(null, hidden, 'gato', 'gato-rom').reading).toBe('');
	});
});
