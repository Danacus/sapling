/**
 * Word boundaries. The concatenation invariant is checked on every case,
 * because both callers render segments instead of the string they came from.
 */

import { describe, expect, it } from 'vitest';

import { segmentWords } from './segment';

/** `text` back out of the segments — the invariant every case is checked against. */
function rebuild(segments: readonly { text: string }[]): string {
	return segments.map((segment) => segment.text).join('');
}

function words(text: string, locale?: string): string[] {
	return segmentWords(text, locale)
		.filter((segment) => segment.isWord)
		.map((segment) => segment.text);
}

describe('segmentWords', () => {
	it('cuts Chinese on dictionary words, not on characters', () => {
		expect(words('我们去银行取钱，然后骑自行车回家。', 'zh')).toEqual([
			'我们',
			'去',
			'银行',
			'取',
			'钱',
			'然后',
			'骑',
			'自行',
			'车',
			'回家'
		]);
	});

	it('cuts Japanese the same way', () => {
		expect(words('私は昨日東京へ行きました', 'ja')).toEqual([
			'私',
			'は',
			'昨日',
			'東京',
			'へ',
			'行き',
			'ま',
			'した'
		]);
	});

	it('marks punctuation and whitespace as non-words', () => {
		const segments = segmentWords('你好，世界！', 'zh');
		expect(segments.filter((segment) => !segment.isWord).map((segment) => segment.text)).toEqual([
			'，',
			'！'
		]);
	});

	it('splits a spaced script on its spaces', () => {
		expect(words('El sábado por la tarde', 'es')).toEqual(['El', 'sábado', 'por', 'la', 'tarde']);
	});

	it('returns nothing for the empty string', () => {
		expect(segmentWords('')).toEqual([]);
	});

	describe('without Intl.Segmenter', () => {
		/** Runs `body` on a host that has no segmenter, and puts it back after. */
		function withoutSegmenter<T>(body: () => T): T {
			// `Intl.Segmenter` is declared read-only, so removing it takes a cast.
			const intl = Intl as unknown as { Segmenter?: typeof Intl.Segmenter };
			const real = intl.Segmenter;
			delete intl.Segmenter;
			try {
				return body();
			} finally {
				intl.Segmenter = real;
			}
		}

		it('falls back to characters for an unspaced script and runs for a spaced one', () => {
			withoutSegmenter(() => {
				expect(words('你好，世界')).toEqual(['你', '好', '世', '界']);
				expect(words('por favor')).toEqual(['por', 'favor']);
			});
		});

		it('still reproduces the input', () => {
			withoutSegmenter(() => {
				expect(rebuild(segmentWords('A: 我去银行, ok? ___ 了'))).toBe('A: 我去银行, ok? ___ 了');
			});
		});
	});

	it('reproduces the input for every case it is given', () => {
		const cases = [
			'我们去银行取钱，然后骑自行车回家。',
			'私は昨日東京へ行きました',
			'El sábado por la tarde fuimos al restaurante.',
			'A: 我去银行, ok? ___ 了',
			'   ',
			'2026年8月25日',
			''
		];
		for (const input of cases) {
			expect(rebuild(segmentWords(input))).toBe(input);
		}
	});
});
