import { describe, expect, it } from 'vitest';

import type { KnowledgeItem } from '$lib/types';
import { annotateSentence } from './annotate';
import type { AnnotateContext } from './annotate';
import { harvestWords } from './harvest';
import { tokenizeByTerms } from './tokenize';

const NOW = Date.UTC(2026, 0, 1);

function item(term: string): KnowledgeItem {
	return {
		id: `id-${term}`,
		kind: 'vocab',
		term,
		meaning: `meaning of ${term}`,
		fsrsCard: null,
		introducedAt: NOW,
		history: []
	};
}

function ctx(overrides: Partial<AnnotateContext> = {}): AnnotateContext {
	return { items: [], knownTerms: [], mode: 'on', rolls: new Map(), ...overrides };
}

/** Segments as the words page annotates them: the reader's own tokens. */
function annotated(texts: string[], context: AnnotateContext, tokenize = tokenizeByTerms) {
	return texts.map((text) => ({ text, words: annotateSentence(text, tokenize, context) }));
}

describe('harvestWords', () => {
	it('lists each new word once, in order of first use, with its count and sentence', () => {
		const words = harvestWords(
			annotated(
				['Dag Els. Goedemorgen, Els!', 'Dit is Els, een collega. Zij heeft 3 x.'],
				ctx({ items: [item('dag')] })
			)
		);
		expect(words.map((w) => [w.term, w.count])).toEqual([
			['Els', 3],
			['Goedemorgen', 1],
			['Dit', 1],
			['is', 1],
			['een', 1],
			['collega', 1],
			['Zij', 1],
			['heeft', 1],
			['x', 1]
		]);
		// The sentence it first stands in, not the whole segment.
		expect(words[1].sentence).toBe('Goedemorgen, Els!');
		expect(words[5].sentence).toBe('Dit is Els, een collega.');
		// No reading for a Latin word: there never was one.
		expect(words.every((w) => w.reading === null)).toBe(true);
	});

	it('leaves out garden words, keeps legacy known ones marked as such', () => {
		const words = harvestWords(
			annotated(['un café con leche'], ctx({ items: [item('café')], knownTerms: ['con'] }))
		);
		expect(words.map((w) => [w.term, w.known])).toEqual([
			['un', false],
			['con', true],
			['leche', false]
		]);
	});

	it('keeps the reader’s own reading, and one spelling with two readings is two entries', () => {
		// A stand-in romanizer: 长 is read by what follows it, as pinyin-pro does.
		const tokenize = (text: string, terms: readonly string[] = []) =>
			tokenizeByTerms(text, terms).map((token, i, all) => ({
				text: token.text,
				reading:
					token.text === '长'
						? all.slice(i + 1).find((next) => next.text.trim())?.text === '大'
							? 'zhǎng'
							: 'cháng'
						: /\p{L}/u.test(token.text)
							? `«${token.text}»`
							: null
			}));
		const words = harvestWords(
			annotated(['长 大', '长 城', '长 大'], ctx(), (text, terms) => tokenize(text, terms))
		);
		expect(words.map((w) => [w.term, w.reading, w.count])).toEqual([
			['长', 'zhǎng', 2],
			['大', '«大»', 2],
			['长', 'cháng', 1],
			['城', '«城»', 1]
		]);
	});
});
