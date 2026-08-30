/**
 * Chunking, whose only jobs are "never split a sentence" and "stay in order".
 * Everything the merge does downstream assumes both.
 */

import { describe, expect, it } from 'vitest';

import { chunkSentences } from './chunks';

describe('chunkSentences', () => {
	it('packs greedily and keeps every sentence, in order', () => {
		const sentences = ['aaaa', 'bbbb', 'cc', 'dddddd'];
		const chunks = chunkSentences(sentences, 10);

		expect(chunks).toEqual([['aaaa', 'bbbb', 'cc'], ['dddddd']]);
		expect(chunks.flat()).toEqual(sentences);
	});

	it('never splits a sentence, so one longer than the budget gets its own chunk', () => {
		const long = 'x'.repeat(50);
		expect(chunkSentences(['a', long, 'b'], 10)).toEqual([['a'], [long], ['b']]);
	});

	it('is one chunk when everything fits', () => {
		expect(chunkSentences(['one.', 'two.'], 4000)).toEqual([['one.', 'two.']]);
	});

	it('has no chunks for no sentences', () => {
		expect(chunkSentences([], 4000)).toEqual([]);
	});

	it('keeps page one stable as more text is added', () => {
		const first = chunkSentences(['aaaa', 'bbbb'], 10);
		const later = chunkSentences(['aaaa', 'bbbb', 'cccc', 'dddd'], 10);
		expect(later[0]).toEqual(first[0]);
	});
});
