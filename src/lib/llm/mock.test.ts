import { describe, expect, it } from 'vitest';
import {
	escalateMock,
	isMockMode,
	mockBatch,
	mockBatchCompletion,
	usesMandarinFixtures
} from './mock';
import { parseBatch, stripFences } from './generate';
import type { BatchArgs } from './generate';
import { challengeSchema, generatedBatchSchema } from './schemas';
import { getEscalation } from './index';
import { checkChallenge } from '$lib/validate';

const args: BatchArgs = {
	profile: {
		nativeLanguage: 'English',
		targetLanguage: 'Spanish',
		level: 'beginner',
		interests: ['reading']
	},
	reviewItems: [
		{ id: 'i1', term: 'el perro', meaning: 'the dog' },
		{ id: 'i2', term: 'la canción', meaning: 'the song' }
	],
	newItemSlots: 2
};

describe('isMockMode', () => {
	it('is on when no API key is configured (node: no localStorage at all)', () => {
		expect(isMockMode()).toBe(true);
	});
});

describe('mockBatchCompletion', () => {
	it('passes the strict generated-batch schema', () => {
		const raw = mockBatchCompletion(args);
		const json: unknown = JSON.parse(stripFences(raw));
		const parsed = generatedBatchSchema.safeParse(json);
		expect(parsed.success).toBe(true);
	});

	it('loses nothing to the real parser', () => {
		const parsed = parseBatch(mockBatchCompletion(args));
		expect(parsed.dropped).toBe(0);
		expect(parsed.newItems).toHaveLength(2);
	});
});

describe('mockBatch', () => {
	const result = mockBatch(args);

	it('produces valid domain challenges through the real resolver', () => {
		expect(result.challenges.length).toBeGreaterThanOrEqual(5);
		for (const challenge of result.challenges) {
			expect(challengeSchema.safeParse(challenge).success).toBe(true);
		}
	});

	it('covers every generated challenge type and both directions', () => {
		const types = new Set(result.challenges.map((c) => c.type));
		expect(types).toEqual(new Set(['multiple-choice', 'cloze', 'typed-translation']));

		const directions = new Set(result.challenges.map((c) => c.direction));
		expect(directions).toEqual(new Set(['toTarget', 'toNative']));

		const withWordBank = result.challenges.filter(
			(c) => c.type === 'cloze' && c.wordBank && c.wordBank.length > 0
		);
		expect(withWordBank.length).toBeGreaterThan(0);
	});

	it('introduces two new items with placeholder card state', () => {
		expect(result.newItems).toHaveLength(2);
		for (const item of result.newItems) {
			expect(item.kind).toBe('vocab');
			// The caller owns FSRS initialization.
			expect(item.fsrsCard).toBeNull();
			expect(item.history).toEqual([]);
		}
		expect(result.newItems.map((i) => i.term)).toEqual(['la cuenta', 'pedir']);
	});

	it('carries no romanization at all for a Latin-script target', () => {
		for (const item of result.newItems) {
			expect('romanization' in item).toBe(false);
		}
		const serialized = JSON.stringify(result.challenges);
		expect(serialized).not.toContain('Romanization');
	});

	it('resolves every placeholder and every review reference', () => {
		const ids = new Set([...args.reviewItems.map((i) => i.id), ...result.newItems.map((i) => i.id)]);
		for (const challenge of result.challenges) {
			expect(challenge.itemIds.length).toBeGreaterThan(0);
			for (const id of challenge.itemIds) {
				expect(id.startsWith('new:')).toBe(false);
				expect(ids.has(id)).toBe(true);
			}
		}
	});

	it('is deterministic and spends no tokens', () => {
		expect(mockBatch(args)).toEqual(result);
		expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
	});

	it('works with no review items at all (first lesson)', () => {
		const cold = mockBatch({ ...args, reviewItems: [] });
		expect(cold.challenges.length).toBeGreaterThanOrEqual(5);
		expect(cold.newItems).toHaveLength(2);
	});
});

describe('the Mandarin fixtures', () => {
	const zhArgs: BatchArgs = {
		...args,
		profile: { ...args.profile, targetLanguage: 'Chinese' },
		reviewItems: []
	};

	it('is selected by the target language, however it was typed', () => {
		expect(usesMandarinFixtures('Chinese')).toBe(true);
		expect(usesMandarinFixtures('Mandarin Chinese')).toBe(true);
		expect(usesMandarinFixtures('zh')).toBe(true);
		expect(usesMandarinFixtures('Spanish')).toBe(false);
		expect(usesMandarinFixtures('')).toBe(false);
	});

	it('passes the strict schema and loses nothing to the real parser', () => {
		const parsed = parseBatch(mockBatchCompletion(zhArgs));
		expect(parsed.dropped).toBe(0);
		const json: unknown = JSON.parse(stripFences(mockBatchCompletion(zhArgs)));
		expect(generatedBatchSchema.safeParse(json).success).toBe(true);
	});

	it('produces valid domain challenges with romanization surviving the resolver', () => {
		const result = mockBatch(zhArgs);
		for (const challenge of result.challenges) {
			expect(challengeSchema.safeParse(challenge).success).toBe(true);
		}

		expect(result.newItems.map((i) => i.romanization)).toEqual(['càidān', 'mǎidān']);

		const mc = result.challenges.filter((c) => c.type === 'multiple-choice');
		expect(mc.find((c) => c.promptRomanization === 'càidān')).toBeDefined();
		expect(mc.find((c) => c.optionsRomanization)?.optionsRomanization).toEqual([
			'càidān',
			'kuàizi',
			'fúwùyuán',
			'chá'
		]);

		const cloze = result.challenges.find((c) => c.type === 'cloze' && c.sentenceRomanization);
		expect(cloze?.type === 'cloze' && cloze.sentenceRomanization).toBe(
			'Nǐ hǎo, qǐng gěi wǒ yī fèn càidān.'
		);
	});

	it('accepts a toneless pinyin answer through the ordinary local validator', () => {
		const result = mockBatch(zhArgs);
		const typed = result.challenges.find((c) => c.type === 'typed-translation');
		expect(typed?.type === 'typed-translation' && checkChallenge(typed, 'maidan')).toBe(
			'correct'
		);
	});

	it('is deterministic', () => {
		expect(mockBatch(zhArgs)).toEqual(mockBatch(zhArgs));
	});
});

describe('escalateMock', () => {
	it('returns a plain-text canned answer with zero usage', () => {
		const result = escalateMock({
			challenge: {
				id: 'c1',
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'the dog',
				acceptedAnswers: ['el perro'],
				itemIds: ['i1']
			},
			answerGiven: 'el pero',
			verdict: 'almost',
			nativeLanguage: 'English',
			targetLanguage: 'Spanish'
		});
		expect(result.answer).toContain('almost');
		expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
	});
});

describe('the facade', () => {
	it('routes escalation to the mock when no key is configured', async () => {
		const result = await getEscalation(
			{
				challenge: {
					id: 'c1',
					type: 'multiple-choice',
					direction: 'toNative',
					prompt: 'el perro',
					options: ['the dog', 'the cat', 'the bread', 'the house'],
					correctIndex: 0,
					itemIds: ['i1']
				},
				answerGiven: 'the cat',
				verdict: 'wrong',
				nativeLanguage: 'English',
				targetLanguage: 'Spanish'
			},
			{
				// Would blow up if the real path were taken.
				fetchFn: () => {
					throw new Error('network must not be touched in mock mode');
				}
			}
		);
		expect(result.answer).toContain('mock answer');
	});
});
