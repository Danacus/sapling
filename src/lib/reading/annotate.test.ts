/**
 * Render-time annotation: the status of every word, and whether it keeps its
 * reading.
 *
 * Pure and deterministic, so the coin flip is injected and the clock is passed
 * in — the same contract `$lib/srs` and `$lib/session/romanization` keep.
 */

import { describe, expect, it } from 'vitest';

import { CardState, type FsrsCardState } from '$lib/srs';
import type { GlossEntry, KnowledgeItem } from '$lib/types';
import { annotateSentence, showSentenceReading, termsFor } from './annotate';
import type { AnnotateContext, ReadingWord } from './annotate';
import { tokenizeByTerms } from './tokenize';

/** Fixed instant: 2026-01-01T00:00:00.000Z. */
const NOW = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

/** A reviewed card of the given stability, last seen just now. */
function card(stabilityDays: number): FsrsCardState {
	return {
		due: NOW + stabilityDays * DAY,
		stability: stabilityDays,
		difficulty: 5,
		elapsed_days: 0,
		scheduled_days: stabilityDays,
		learning_steps: 0,
		reps: 5,
		lapses: 0,
		state: CardState.Review,
		last_review: NOW
	};
}

function item(term: string, stabilityDays = 0, romanization?: string): KnowledgeItem {
	return {
		id: `id-${term}`,
		kind: 'vocab',
		term,
		meaning: `meaning of ${term}`,
		...(romanization ? { romanization } : {}),
		fsrsCard: stabilityDays > 0 ? card(stabilityDays) : null,
		introducedAt: NOW,
		history: []
	};
}

/**
 * A tokenizer that hands every word a reading, standing in for a real
 * romanizer: without one, "the reading was taken away" and "there never was
 * one" are the same null and nothing about visibility is observable.
 */
function withReadings(text: string, terms: readonly string[] = []) {
	return tokenizeByTerms(text, terms).map((token) => ({
		text: token.text,
		reading: /[\p{L}\p{N}]/u.test(token.text) ? `«${token.text}»` : null
	}));
}

function ctx(overrides: Partial<AnnotateContext> = {}): AnnotateContext {
	return {
		items: [],
		knownTerms: [],
		glossary: [],
		mode: 'on',
		now: NOW,
		rolls: new Map(),
		...overrides
	};
}

function statusOf(words: ReadingWord[], text: string): ReadingWord | undefined {
	return words.find((word) => word.text === text);
}

describe('termsFor', () => {
	it('unions vocabulary, glossary and known terms, deduped by key', () => {
		expect(
			termsFor(
				ctx({
					items: [item('mesa'), item('sopa')],
					glossary: [
						{ term: 'cuenta', meaning: 'the bill' },
						{ term: 'MESA', meaning: 'table' }
					],
					knownTerms: ['  sopa  ', 'hola']
				})
			)
		).toEqual(['mesa', 'sopa', 'cuenta', 'hola']);
	});
});

describe('annotateSentence', () => {
	it('gives every word its status', () => {
		const words = annotateSentence(
			'La mesa, la cuenta y la silla.',
			tokenizeByTerms,
			ctx({
				items: [item('mesa')],
				knownTerms: ['la'],
				glossary: [{ term: 'cuenta', meaning: 'the bill' }]
			})
		);

		expect(statusOf(words, 'mesa')?.status).toBe('tracked');
		expect(statusOf(words, 'La')?.status).toBe('known');
		expect(statusOf(words, 'cuenta')?.status).toBe('new');
		expect(statusOf(words, 'silla')?.status).toBe('plain');
	});

	it('matches case-insensitively, on the one normalization', () => {
		const words = annotateSentence('MESA', tokenizeByTerms, ctx({ items: [item('mesa')] }));
		expect(words[0]).toMatchObject({ status: 'tracked', key: 'mesa', itemId: 'id-mesa' });
	});

	it("takes a tracked word's gloss from the item, not the glossary", () => {
		const words = annotateSentence(
			'mesa',
			tokenizeByTerms,
			ctx({
				items: [item('mesa', 0, 'me-sa')],
				glossary: [{ term: 'mesa', meaning: 'the glossary is wrong here' }]
			})
		);
		expect(words[0].gloss).toEqual({ term: 'mesa', meaning: 'meaning of mesa', reading: 'me-sa' });
		expect(words[0].maturity).toBe('new');
	});

	it("takes a new word's gloss from the glossary, reading included", () => {
		const glossary: GlossEntry[] = [{ term: '饭馆', reading: 'fàn guǎn', meaning: 'restaurant' }];
		const words = annotateSentence('去饭馆', tokenizeByTerms, ctx({ glossary }));
		expect(statusOf(words, '饭馆')?.gloss).toEqual({
			term: '饭馆',
			meaning: 'restaurant',
			reading: 'fàn guǎn'
		});
	});

	it('reports maturity for a tracked word, from the same floors the planner uses', () => {
		const words = annotateSentence(
			'mesa sopa',
			tokenizeByTerms,
			ctx({ items: [item('mesa', 30), item('sopa')] })
		);
		expect(statusOf(words, 'mesa')?.maturity).toBe('solid');
		expect(statusOf(words, 'sopa')?.maturity).toBe('new');
	});

	it('gives punctuation and whitespace no key, no gloss and no reading', () => {
		const words = annotateSentence('mesa, silla', withReadings, ctx());
		const gap = words.find((word) => word.text === ', ');
		expect(gap).toEqual({ text: ', ', reading: null, status: 'plain' });
		expect(gap).not.toHaveProperty('key');
	});

	it('reproduces the sentence exactly', () => {
		const input = '¿La mesa, por favor? 我们去银行。';
		const words = annotateSentence(input, tokenizeByTerms, ctx({ items: [item('mesa')] }));
		expect(words.map((word) => word.text).join('')).toBe(input);
	});

	describe('reading visibility', () => {
		it('keeps every reading under "on"', () => {
			const words = annotateSentence(
				'mesa silla',
				withReadings,
				ctx({ mode: 'on', items: [item('mesa', 90)], knownTerms: ['silla'] })
			);
			expect(words.map((word) => word.reading)).toEqual(['«mesa»', null, '«silla»']);
		});

		it('nulls every reading under "off"', () => {
			const words = annotateSentence(
				'mesa silla',
				withReadings,
				ctx({ mode: 'off', items: [item('mesa')] })
			);
			expect(words.every((word) => word.reading === null)).toBe(true);
		});

		it('takes the crutch away from a word the learner marked known', () => {
			const words = annotateSentence(
				'mesa silla',
				withReadings,
				ctx({ mode: 'adaptive', knownTerms: ['silla'], rng: () => 0 })
			);
			expect(statusOf(words, 'silla')?.reading).toBeNull();
			// An untracked word keeps its reading: it is the one that needs it.
			expect(statusOf(words, 'mesa')?.reading).toBe('«mesa»');
		});

		it('rolls a tracked word once per text and remembers the answer', () => {
			let rolls = 0;
			const rng = () => {
				rolls++;
				return 0.99;
			};
			const shared = ctx({ mode: 'adaptive', items: [item('mesa', 365)], rng });

			// Strength is past the ceiling, so the hide probability is 1 and 0.99
			// loses: the reading goes, in this sentence and in the next.
			const first = annotateSentence('la mesa', withReadings, shared);
			const second = annotateSentence('otra mesa', withReadings, shared);

			expect(statusOf(first, 'mesa')?.reading).toBeNull();
			expect(statusOf(second, 'mesa')?.reading).toBeNull();
			expect(rolls).toBe(1);
			expect(shared.rolls.get('mesa')).toBe(false);
		});

		it("keeps a weak tracked word's reading whatever the roll says", () => {
			const words = annotateSentence(
				'mesa',
				withReadings,
				ctx({ mode: 'adaptive', items: [item('mesa')], rng: () => 0 })
			);
			expect(words[0].reading).toBe('«mesa»');
		});
	});
});

describe('showSentenceReading', () => {
	const words = (mode: AnnotateContext['mode'], overrides: Partial<AnnotateContext> = {}) =>
		annotateSentence('mesa silla', withReadings, ctx({ mode, ...overrides }));

	it('always shows under "on" and never under "off"', () => {
		expect(showSentenceReading(words('on'), 'on')).toBe(true);
		expect(showSentenceReading(words('off'), 'off')).toBe(false);
	});

	it('shows while any word still deserves the crutch', () => {
		const some = words('adaptive', { items: [item('mesa', 365)], rng: () => 0.99 });
		expect(showSentenceReading(some, 'adaptive')).toBe(true);
	});

	it('goes away once the whole sentence is words the learner has outgrown', () => {
		const outgrown = words('adaptive', { knownTerms: ['mesa', 'silla'] });
		expect(showSentenceReading(outgrown, 'adaptive')).toBe(false);
	});

	it('does not depend on a local romanizer existing', () => {
		// `tokenizeByTerms` produces no readings at all — the very case the stored
		// sentence reading is the fallback for.
		const bare = annotateSentence(
			'mesa silla',
			tokenizeByTerms,
			ctx({ mode: 'adaptive', knownTerms: ['mesa'] })
		);
		expect(bare.every((word) => word.reading === null)).toBe(true);
		expect(showSentenceReading(bare, 'adaptive')).toBe(true);
	});
});
