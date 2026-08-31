/**
 * The fallback tokenizer.
 *
 * Every case checks the concatenation invariant, because a caller renders these
 * tokens *instead of* the sentence and has no way to notice a lost character.
 */

import { describe, expect, it } from 'vitest';

import { termKey } from '$lib/text';
import { tokenizeByTerms, wordKey } from './tokenize';

/** `text` back out of the tokens, and the readings, in one go. */
function texts(tokens: readonly { text: string }[]): string[] {
	return tokens.map((token) => token.text);
}

/** Tokenizes and asserts the invariant, returning the token texts. */
function cut(text: string, terms: string[] = []): string[] {
	const tokens = tokenizeByTerms(text, terms);
	expect(tokens.map((token) => token.text).join('')).toBe(text);
	expect(tokens.every((token) => token.reading === null)).toBe(true);
	return texts(tokens);
}

/**
 * `wordKey` is `termKey` from `$lib/text` under this module's name for it, and
 * the rule itself is pinned in `$lib/text/keys.test.ts`. What is worth asserting
 * here is that the reader's own name still answers the reader's own question.
 */
describe('wordKey', () => {
	it('is the shared spelling key', () => {
		expect(wordKey('  Por   Favor ')).toBe(termKey('por favor'));
	});

	it('trims, lower-cases and normalizes', () => {
		expect(wordKey('  Café  ')).toBe('café');
		expect(wordKey('CAFÉ')).toBe('café');
		// Combining acute vs the precomposed character: the same word.
		expect(wordKey('café')).toBe(wordKey('café'));
	});

	it('folds nothing else — a missing accent is a different word', () => {
		expect(wordKey('ecole')).not.toBe(wordKey('école'));
	});
});

describe('tokenizeByTerms, spaced scripts', () => {
	it('cuts words, whitespace and punctuation apart', () => {
		expect(cut('El camarero, por favor.')).toEqual([
			'El',
			' ',
			'camarero',
			', ',
			'por',
			' ',
			'favor',
			'.'
		]);
	});

	it('keeps a multi-word term together, across its space', () => {
		expect(cut('¿Por favor, una mesa?', ['por favor'])).toEqual([
			'¿',
			'Por favor',
			', ',
			'una',
			' ',
			'mesa',
			'?'
		]);
	});

	it('matches a term case-insensitively', () => {
		expect(cut('CAMARERO camarero Camarero', ['Camarero'])).toEqual([
			'CAMARERO',
			' ',
			'camarero',
			' ',
			'Camarero'
		]);
	});

	it('never cuts a longer word in half to honour a shorter term', () => {
		expect(cut('portal por favor', ['por'])).toEqual(['portal', ' ', 'por', ' ', 'favor']);
	});

	it('keeps an internal apostrophe or hyphen inside the word', () => {
		expect(cut("l'école no-one's")).toEqual(["l'école", ' ', "no-one's"]);
	});

	it('prefers the longest matching term', () => {
		expect(cut('la mesa grande', ['mesa', 'mesa grande'])).toEqual(['la', ' ', 'mesa grande']);
	});
});

describe('tokenizeByTerms, unspaced scripts', () => {
	it('cuts on dictionary word boundaries rather than characters', () => {
		expect(cut('我们去银行取钱。')).toEqual(['我们', '去', '银行', '取', '钱', '。']);
	});

	it('lets a vocabulary term beat the dictionary, greedily', () => {
		// ICU prefers 自行 + 车; the learner studying 自行车 gets one token.
		expect(cut('骑自行车回家')).toEqual(['骑', '自行', '车', '回家']);
		expect(cut('骑自行车回家', ['自行车'])).toEqual(['骑', '自行车', '回家']);
	});

	it('leaves the tail of a segment a term cut into as its own token', () => {
		expect(cut('然后骑车')).toEqual(['然后', '骑车']);
		expect(cut('然后骑车', ['然'])).toEqual(['然', '后', '骑车']);
	});

	it('keeps a Latin run inside a Chinese sentence in one piece', () => {
		expect(cut('我说OK了')).toEqual(['我', '说', 'OK', '了']);
	});

	it('runs punctuation together and gives it no reading', () => {
		expect(cut('姐姐问：“有吗？”')).toEqual(['姐姐', '问', '：“', '有', '吗', '？”']);
	});
});

describe('tokenizeByTerms, degenerate input', () => {
	it('returns nothing for the empty string', () => {
		expect(tokenizeByTerms('')).toEqual([]);
	});

	it('keeps whitespace-only input as one reading-less token', () => {
		expect(tokenizeByTerms('   ')).toEqual([{ text: '   ', reading: null }]);
	});

	it('ignores blank and duplicate terms', () => {
		expect(cut('por favor', ['', '   ', 'por favor', 'POR FAVOR'])).toEqual(['por favor']);
	});

	it('reconstructs the input for every case it is given', () => {
		const cases = [
			'El camarero, por favor.',
			'我们去银行取钱，然后骑自行车回家。',
			'A: 我去银行, ok? ___ 了',
			"l'école — no-one's «mesa»",
			'2026年8月25日',
			'   ',
			'𠀋という漢字',
			''
		];
		for (const input of cases) {
			const tokens = tokenizeByTerms(input, ['银行', '自行车', 'por favor', '漢字']);
			expect(tokens.map((token) => token.text).join('')).toBe(input);
		}
	});
});
