import { describe, expect, it } from 'vitest';

import type { InboxEntry, TermList } from '$lib/extension/protocol';
import { tokenizeByTerms } from '$lib/reading/tokenize';
import { zhRomanizer } from '$lib/romanize/zh';

import { buildIndex, lookUp, marksOf, sentenceAround, spanAt } from './highlight';

const spanish: TermList = {
	language: 'es',
	languageName: 'Spanish',
	terms: [
		{ term: 'gato', meaning: 'cat', status: 'new' },
		{ term: 'por favor', meaning: 'please', status: 'known' },
		{ term: 'Casa', status: 'learning' }
	]
};

const collected = (term: string): InboxEntry => ({
	id: term,
	term,
	sentence: '',
	pageTitle: '',
	url: 'https://example.org',
	language: 'es',
	collectedAt: 0
});

describe('marksOf', () => {
	it('underlines listed words by status and collected words as collected', () => {
		const index = buildIndex(spanish, [collected('perro')]);
		const text = 'Mi gato, por favor, y el perro en la casa.';
		const marks = marksOf(tokenizeByTerms(text, index.terms), index);
		expect(marks.map(({ start, end, mark }) => [text.slice(start, end), mark])).toEqual([
			['gato', 'new'],
			['por favor', 'known'],
			['perro', 'collected'],
			['casa', 'learning']
		]);
	});

	it('leaves a page with no list unmarked', () => {
		const index = buildIndex(undefined, []);
		expect(marksOf(tokenizeByTerms('Mi gato duerme.', index.terms), index)).toEqual([]);
	});

	it('counts offsets in UTF-16, as a DOM Range does', () => {
		const index = buildIndex(spanish, []);
		const text = '😺 gato';
		const [mark] = marksOf(tokenizeByTerms(text, index.terms), index);
		expect([mark.start, mark.end]).toEqual([3, 7]);
		expect(text.slice(mark.start, mark.end)).toBe('gato');
	});

	it('keeps a listed Chinese word whole and tells homographs apart by reading', () => {
		const list: TermList = {
			language: 'zh',
			languageName: 'Chinese',
			terms: [
				{ term: '自行车', reading: 'zìxíngchē', status: 'learning' },
				{ term: '长', reading: 'cháng', status: 'known' },
				{ term: '长', reading: 'zhǎng', status: 'new' }
			]
		};
		const index = buildIndex(list, []);
		const text = '我的自行车很长。';
		const marks = marksOf(zhRomanizer.tokenize(text, index.terms), index);
		expect(marks.map(({ start, end, mark }) => [text.slice(start, end), mark])).toEqual([
			['自行车', 'learning'],
			['长', 'known']
		]);
	});
});

describe('lookUp', () => {
	it('matches spelling case-insensitively and falls back to the first homograph', () => {
		const index = buildIndex(spanish, []);
		expect(lookUp(index, 'GATO', null)?.meaning).toBe('cat');
		expect(lookUp(index, 'perro', null)).toBeUndefined();
	});
});

describe('spanAt', () => {
	it('finds the word holding a character, and nothing on punctuation', () => {
		const tokens = tokenizeByTerms('Hola, gato.', []);
		expect(spanAt(tokens, 0)?.token.text).toBe('Hola');
		expect(spanAt(tokens, 3)?.token.text).toBe('Hola');
		expect(spanAt(tokens, 4)).toBeUndefined();
		expect(spanAt(tokens, 6)?.token.text).toBe('gato');
		expect(spanAt(tokens, 99)).toBeUndefined();
	});
});

describe('sentenceAround', () => {
	it('returns the sentence holding the offset, whitespace collapsed', () => {
		const text = 'Primera frase.\n   El gato\n duerme mucho. Tercera.';
		expect(sentenceAround(text, text.indexOf('gato'))).toBe('El gato duerme mucho.');
		expect(sentenceAround(text, 0)).toBe('Primera frase.');
		expect(sentenceAround(text, text.length + 5)).toBe('Tercera.');
	});

	it('cuts an unspaced script on its own full stops', () => {
		const text = '我有一只猫。它很小。';
		expect(sentenceAround(text, text.indexOf('小'))).toBe('它很小。');
	});
});
