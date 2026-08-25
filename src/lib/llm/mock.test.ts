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
import { checkChallenge } from '$lib/challenges/check';

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

	it('honors zero new-item slots: review-only batches introduce nothing', () => {
		const reviewOnly = mockBatch({ ...args, newItemSlots: 0 });
		expect(reviewOnly.newItems).toEqual([]);
		expect(reviewOnly.challenges.length).toBeGreaterThan(0);
		const known = new Set(args.reviewItems.map((i) => i.id));
		for (const challenge of reviewOnly.challenges) {
			for (const id of challenge.itemIds) expect(known.has(id)).toBe(true);
		}
	});

	it('covers every generated challenge type and both directions', () => {
		const types = new Set(result.challenges.map((c) => c.type));
		expect(types).toEqual(
			new Set(['multiple-choice', 'cloze', 'typed-translation', 'word-order', 'spot-error'])
		);

		const directions = new Set(result.challenges.map((c) => c.direction));
		expect(directions).toEqual(new Set(['toTarget', 'toNative']));

		// Both cloze modes: a word bank to tap, and one to type.
		const clozes = result.challenges.filter((c) => c.type === 'cloze');
		expect(clozes.filter((c) => c.wordBank?.length).length).toBeGreaterThan(0);
		expect(clozes.filter((c) => !c.wordBank).length).toBeGreaterThan(0);
	});

	it('shuffles the correct option rather than parking it in one slot', () => {
		const mc = result.challenges.filter((c) => c.type === 'multiple-choice');
		expect(mc.length).toBeGreaterThan(2);
		// Whatever the seeded shuffle chose, correctIndex points at the answer.
		const expected = ['Could you bring us the bill, please?', 'pedir'];
		for (const challenge of mc.slice(0, 2)) {
			expect(expected).toContain(challenge.options[challenge.correctIndex]);
		}
		expect(new Set(mc.map((c) => c.correctIndex)).size).toBeGreaterThan(1);
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

	it('carries a conversational instruction on exactly one canned multiple-choice challenge', () => {
		// Exercises the UI path for the instruction heading in practice mode,
		// while every other challenge falls back to the component's default.
		const withInstruction = result.challenges.filter(
			(c) => c.type === 'multiple-choice' && c.instruction
		);
		expect(withInstruction).toHaveLength(1);
		expect(
			withInstruction[0].type === 'multiple-choice' ? withInstruction[0].instruction : undefined
		).toBe('What is the customer asking for?');
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

	it('shuffles the word-order tiles without disturbing the answer', () => {
		const wordOrder = result.challenges.find((c) => c.type === 'word-order');
		if (wordOrder?.type !== 'word-order') throw new Error('expected a word-order challenge');

		expect(wordOrder.answerTokens).toEqual([
			'¿Nos',
			'trae',
			'la',
			'cuenta,',
			'por',
			'favor?'
		]);
		expect(wordOrder.answer).toBe('¿Nos trae la cuenta, por favor?');
		// Two distractors on top of the six real tiles, all still available.
		expect(wordOrder.tiles).toHaveLength(8);
		for (const token of wordOrder.answerTokens) expect(wordOrder.tiles).toContain(token);
		expect(wordOrder.tiles).not.toEqual(wordOrder.answerTokens);
	});

	it('corrupts the spot-error sentence at the stated position only', () => {
		const spot = result.challenges.find((c) => c.type === 'spot-error');
		if (spot?.type !== 'spot-error') throw new Error('expected a spot-error challenge');

		expect(spot.tokens).toEqual(['Quisiera', 'pagar', 'el', 'pescado.']);
		expect(spot.correctIndex).toBe(1);
		expect(spot.intendedWord).toBe('pedir');
		expect(spot.correctedSentence).toBe('Quisiera pedir el pescado.');
		expect(spot.meaning).toBe('I would like to order the fish.');
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

		const readings: Record<string, string> = {
			菜单: 'càidān',
			筷子: 'kuàizi',
			服务员: 'fúwùyuán',
			茶: 'chá',
			水: 'shuǐ'
		};

		const mc = result.challenges.filter((c) => c.type === 'multiple-choice');
		// Target shown, meaning picked: the prompt gets the reading, the native
		// options get none.
		const recognize = mc.find((c) => c.promptRomanization === 'càidān');
		expect(recognize).toBeDefined();
		expect(recognize && 'optionsRomanization' in recognize).toBe(false);

		// Target picked: every option is annotated, aligned with the shuffle.
		const produce = mc.find((c) => c.optionsRomanization);
		expect(produce?.optionsRomanization).toEqual(produce?.options.map((o) => readings[o]));
		expect(produce && 'promptRomanization' in produce).toBe(false);
	});

	it('reads the cloze around the blank without ever spelling it out', () => {
		const result = mockBatch(zhArgs);
		const cloze = result.challenges.find((c) => c.type === 'cloze' && c.wordBank);
		expect(cloze?.type === 'cloze' && cloze.sentence).toBe('你好，请给我一份___。');
		expect(cloze?.type === 'cloze' && cloze.sentenceRomanization).toBe(
			'Nǐ hǎo, qǐng gěi wǒ yī fèn ___.'
		);
		// The answer's reading is in a field of its own; it cannot reach this line.
		expect(cloze?.type === 'cloze' && cloze.sentenceRomanization).not.toContain('càidān');

		const bank = cloze?.type === 'cloze' ? cloze : undefined;
		expect(bank?.wordBank).toContain('菜单');
		expect(bank?.wordBankRomanization).toHaveLength(bank?.wordBank?.length ?? 0);
	});

	it('accepts a toneless pinyin answer through the ordinary local validator', () => {
		const result = mockBatch(zhArgs);
		const typed = result.challenges.find(
			(c) => c.type === 'typed-translation' && c.direction === 'toTarget'
		);
		// Nothing in the fixture lists "maidan": the resolver folded the tones off
		// the reading it was given.
		expect(typed?.type === 'typed-translation' && checkChallenge(typed, 'maidan')).toBe('correct');
		const cloze = result.challenges.find((c) => c.type === 'cloze' && !c.wordBank);
		expect(cloze?.type === 'cloze' && checkChallenge(cloze, 'maidan')).toBe('correct');
	});

	it('segments per word and joins without spaces, as the script demands', () => {
		const result = mockBatch(zhArgs);

		const wordOrder = result.challenges.find((c) => c.type === 'word-order');
		if (wordOrder?.type !== 'word-order') throw new Error('expected a word-order challenge');
		// 菜单 is one tile, not 菜 + 单 — the whole reason the model segments —
		// and its sentence-final 。 rides on it rather than being a tile itself.
		expect(wordOrder.answerTokens).toContain('菜单。');
		expect(wordOrder.answer).toBe('你好，请给我菜单。');
		expect(wordOrder.answer).not.toContain(' ');
		// Readings are Latin, so they stay space-separated whatever the script.
		expect(wordOrder.answerRomanization).toBe('nǐ hǎo qǐng gěi wǒ càidān');
		expect(wordOrder.tilesRomanization).toHaveLength(wordOrder.tiles.length);

		const spot = result.challenges.find((c) => c.type === 'spot-error');
		if (spot?.type !== 'spot-error') throw new Error('expected a spot-error challenge');
		expect(spot.tokens).toEqual(['我们', '想', '菜单']);
		expect(spot.intendedWord).toBe('买单');
		expect(spot.correctedSentence).toBe('我们想买单');
		expect(spot.tokensRomanization).toEqual(['wǒmen', 'xiǎng', 'càidān']);
		expect(spot.intendedWordRomanization).toBe('mǎidān');
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
		// The mock is in no position to judge a dispute, so it never overturns.
		expect(result.overturn).toBe(false);
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
		expect(result.overturn).toBe(false);
	});
});
