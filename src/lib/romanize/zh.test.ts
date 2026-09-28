import { describe, expect, it } from 'vitest';

import { tokenizeMandarin, zhRomanizer } from './zh';

/** `text` back out of the tokens — the invariant every case is checked against. */
function rebuild(tokens: readonly { text: string }[]): string {
	return tokens.map((token) => token.text).join('');
}

describe('tokenizeMandarin', () => {
	describe('polyphone readings come from the sentence, not the character', () => {
		it('reads 行 as háng in 银行', () => {
			const tokens = tokenizeMandarin('我们去银行');
			expect(tokens.map((token) => token.reading)).toEqual(['wǒ men', 'qù', 'yín háng']);
		});

		it('reads 行 as xíng in 自行车', () => {
			const tokens = tokenizeMandarin('他会骑自行车');
			expect(tokens.map((token) => token.reading)).toEqual(['tā', 'huì', 'qí', 'zì xíng', 'chē']);
		});

		it('keeps the context reading when the term is grouped', () => {
			const [bank] = tokenizeMandarin('银行', ['银行']);
			expect(bank).toEqual({ text: '银行', reading: 'yín háng' });
		});

		it('applies 一 tone sandhi', () => {
			expect(tokenizeMandarin('一下').map((token) => token.reading)).toEqual(['yí xià']);
		});
	});

	describe('grouping by the learner vocabulary', () => {
		it('makes each matched term one token and cuts the rest on word boundaries', () => {
			const tokens = tokenizeMandarin('我们去银行取钱', ['银行', '取钱']);
			expect(tokens).toEqual([
				{ text: '我们', reading: 'wǒ men' },
				{ text: '去', reading: 'qù' },
				{ text: '银行', reading: 'yín háng' },
				{ text: '取钱', reading: 'qǔ qián' }
			]);
		});

		it('prefers the longest matching term', () => {
			expect(tokenizeMandarin('中国人', ['中国', '中国人'])).toEqual([
				{ text: '中国人', reading: 'zhōng guó rén' }
			]);
		});

		it('beats the segmenter where the learner has an opinion', () => {
			// ICU cuts 自行车 into 自行 + 车; a learner studying the whole word gets
			// one token, one reading and one card.
			expect(tokenizeMandarin('自行车').map((token) => token.text)).toEqual(['自行', '车']);
			expect(tokenizeMandarin('自行车', ['自行车'])).toEqual([
				{ text: '自行车', reading: 'zì xíng chē' }
			]);
		});

		it('falls back to the segmenter when no term matches', () => {
			expect(tokenizeMandarin('中国人', ['银行'])).toEqual([
				{ text: '中国人', reading: 'zhōng guó rén' }
			]);
		});

		it('ignores terms that are not pure Han script', () => {
			// A mixed or Latin term can never align with Hanzi entries; it must not
			// throw, and it must not disturb the segmenter's own split.
			expect(tokenizeMandarin('中国', ['bank', '中 国', ''])).toEqual([
				{ text: '中国', reading: 'zhōng guó' }
			]);
		});

		it('groups a term wherever it recurs', () => {
			const tokens = tokenizeMandarin('银行银行', ['银行']);
			expect(tokens.map((token) => token.text)).toEqual(['银行', '银行']);
		});
	});

	describe('non-Chinese spans', () => {
		it('reproduces mixed text exactly and gives Latin, punctuation and the gap no reading', () => {
			const input = 'A: 我去银行, ok? ___ 了';
			const tokens = tokenizeMandarin(input, ['银行']);

			expect(rebuild(tokens)).toBe(input);
			expect(tokens).toEqual([
				{ text: 'A: ', reading: null },
				{ text: '我去', reading: 'wǒ qù' },
				{ text: '银行', reading: 'yín háng' },
				{ text: ', ok? ___ ', reading: null },
				{ text: '了', reading: expect.any(String) }
			]);
		});

		it('never lets a word boundary cross a non-Chinese run', () => {
			// The merged Latin/punctuation entry is its own token whatever ICU
			// thinks, so a segment spanning 说 and "OK" cannot glue them together.
			expect(tokenizeMandarin('我说OK了').map((token) => token.text)).toEqual([
				'我',
				'说',
				'OK',
				'了'
			]);
		});

		it('treats CJK punctuation as a reading-less span', () => {
			const tokens = tokenizeMandarin('你好。');
			expect(tokens.at(-1)).toEqual({ text: '。', reading: null });
		});
	});

	describe('degenerate input', () => {
		it('returns no tokens for the empty string', () => {
			expect(tokenizeMandarin('')).toEqual([]);
		});

		it('keeps whitespace-only input as one reading-less token', () => {
			expect(tokenizeMandarin('   ')).toEqual([{ text: '   ', reading: null }]);
		});

		it('handles text with no Chinese at all', () => {
			expect(tokenizeMandarin('hello world', ['银行'])).toEqual([
				{ text: 'hello world', reading: null }
			]);
		});
	});

	it('reconstructs the input for every case it is given', () => {
		const cases = [
			'我们去银行取钱',
			'A: 我去银行, ok? ___ 了',
			'你好，世界！',
			'   ',
			'hello world',
			'2026年8月25日',
			''
		];
		for (const input of cases) {
			expect(rebuild(tokenizeMandarin(input, ['银行', '取钱', '世界']))).toBe(input);
		}
	});

	it('is reachable through the Romanizer interface', () => {
		expect(zhRomanizer.tokenize('银行', ['银行'])).toEqual([{ text: '银行', reading: 'yín háng' }]);
	});
});
