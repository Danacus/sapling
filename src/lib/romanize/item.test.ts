import { describe, expect, it } from 'vitest';

import { itemReadingTokens, localReadings, readingFold } from './item';
import type { Romanizer } from './types';
import { zhRomanizer } from './zh';

describe('readingFold', () => {
	it('folds tones, case, spacing and apostrophes to one key', () => {
		for (const spelling of ['Nǐ hǎo', 'ni hao', 'nǐhǎo', "Ni'hao", 'NI-HAO']) {
			expect(readingFold(spelling), spelling).toBe('nihao');
		}
	});

	it('folds an umlaut the way a toneless typist would', () => {
		expect(readingFold('lǜ')).toBe(readingFold('lu'));
	});
});

describe('itemReadingTokens', () => {
	describe('with a stored reading and a local romanizer', () => {
		it('splits the term per character with local tone marks when the two agree', () => {
			expect(itemReadingTokens({ term: '银行', romanization: 'yinhang' }, zhRomanizer)).toEqual([
				{ text: '银', reading: 'yín' },
				{ text: '行', reading: 'háng' }
			]);
		});

		it('keeps the stored reading over the whole term when they disagree', () => {
			// The learner's card says this 行 is the one in 银行; the dictionary
			// default for a lone 行 is xíng. The card wins.
			expect(itemReadingTokens({ term: '行', romanization: 'háng' }, zhRomanizer)).toEqual([
				{ text: '行', reading: 'háng' }
			]);
		});

		it('agrees across spacing and tone spelling differences', () => {
			expect(
				itemReadingTokens({ term: '自行车', romanization: 'zì xíng chē' }, zhRomanizer)
			).toEqual([
				{ text: '自', reading: 'zì' },
				{ text: '行', reading: 'xíng' },
				{ text: '车', reading: 'chē' }
			]);
		});

		it('leaves a single agreeing character as one token', () => {
			expect(itemReadingTokens({ term: '菜', romanization: 'cai' }, zhRomanizer)).toEqual([
				{ text: '菜', reading: 'cài' }
			]);
		});
	});

	it('shows the stored reading over the whole term with no local romanizer', () => {
		expect(itemReadingTokens({ term: 'ありがとう', romanization: 'arigatou' }, null)).toEqual([
			{ text: 'ありがとう', reading: 'arigatou' }
		]);
	});

	it('uses the local reading alone when nothing is stored', () => {
		expect(itemReadingTokens({ term: '菜单' }, zhRomanizer)).toEqual([
			{ text: '菜', reading: 'cài' },
			{ text: '单', reading: 'dān' }
		]);
	});

	it('is null with neither', () => {
		expect(itemReadingTokens({ term: 'gracias' }, null)).toBeNull();
		expect(itemReadingTokens({ term: 'gracias', romanization: '   ' }, null)).toBeNull();
		expect(itemReadingTokens({ term: '   ' }, zhRomanizer)).toBeNull();
	});

	it('is null for a Latin term the local romanizer has no reading for', () => {
		expect(itemReadingTokens({ term: 'café' }, zhRomanizer)).toBeNull();
	});

	it('keeps a token whole when syllables and characters do not pair up', () => {
		const odd: Romanizer = {
			tokenize: (text) => [{ text, reading: 'one two three' }]
		};
		expect(itemReadingTokens({ term: '银行' }, odd)).toEqual([
			{ text: '银行', reading: 'one two three' }
		]);
	});
});

describe('localReadings', () => {
	const items = [
		{ id: 'a', term: '银行' },
		{ id: 'b', term: '行' },
		{ id: 'c', term: '菜' },
		{ id: 'd', term: '菜单', romanization: 'cài dān' },
		{ id: 'e', term: 'gracias' }
	];

	it('answers only the context-free readings of items with none stored', () => {
		expect([...localReadings(items, zhRomanizer)]).toEqual([
			['a', 'yín háng'],
			['c', 'cài']
		]);
	});

	it('is empty with no romanizer, or one that cannot read in isolation', () => {
		expect(localReadings(items, null).size).toBe(0);
		expect(localReadings(items, { tokenize: () => [] }).size).toBe(0);
	});
});
