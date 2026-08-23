import { describe, expect, it } from 'vitest';
import {
	batchJsonSchema,
	challengeSchema,
	clozeChallengeSchema,
	generatedBatchSchema,
	generatedChallengeSchema,
	multipleChoiceChallengeSchema,
	spotErrorChallengeSchema,
	targetTextSchema,
	wordOrderChallengeSchema
} from './schemas';

type JsonNode = Record<string, unknown>;

/** A Latin-script batch: every `reading` is null and nothing is lost by it. */
const validBatch = {
	challenges: [
		{
			type: 'recognize-mc',
			shown: { text: 'el perro', reading: null },
			correctMeaning: 'the dog',
			distractors: ['the cat', 'the bread', 'the house'],
			itemIds: ['i1'],
			explanation: null
		},
		{
			type: 'produce-mc',
			promptNative: 'to order (food in a restaurant)',
			correct: { text: 'pedir', reading: null },
			distractors: [
				{ text: 'pagar', reading: null },
				{ text: 'probar', reading: null },
				{ text: 'servir', reading: null }
			],
			itemIds: ['i2'],
			explanation: null
		},
		{
			type: 'cloze',
			before: { text: 'Yo ', reading: null },
			answer: { text: 'leo', reading: null },
			after: { text: ' un libro.', reading: null },
			hintNative: 'I read a book.',
			distractorWords: [
				{ text: 'como', reading: null },
				{ text: 'bebo', reading: null },
				{ text: 'corro', reading: null }
			],
			itemIds: ['new:0'],
			explanation: 'leer -> leo'
		},
		{
			type: 'translate-to-target',
			promptNative: 'the water is cold',
			answers: [{ text: 'el agua está fría', reading: null }],
			itemIds: ['i2']
		},
		{
			type: 'translate-to-native',
			prompt: { text: 'la cuenta', reading: null },
			answersNative: ['the bill', 'the check'],
			itemIds: ['i1']
		},
		{
			type: 'word-order',
			promptNative: 'I read a book.',
			words: [
				{ text: 'Yo', reading: null },
				{ text: 'leo', reading: null },
				{ text: 'un', reading: null },
				{ text: 'libro.', reading: null }
			],
			distractorWords: [{ text: 'bebo', reading: null }],
			instruction: null,
			itemIds: ['new:0'],
			explanation: null
		},
		{
			type: 'spot-error',
			words: [
				{ text: 'Yo', reading: null },
				{ text: 'leo', reading: null },
				{ text: 'un', reading: null },
				{ text: 'libro.', reading: null }
			],
			wrongWord: { text: 'bebo', reading: null },
			wrongPosition: 1,
			meaningNative: 'I read a book.',
			itemIds: ['new:0'],
			explanation: null
		}
	],
	newItems: [{ term: 'leer', meaning: 'to read', notes: null }]
};

describe('targetTextSchema', () => {
	it('accepts a reading, a null reading and an omitted one', () => {
		expect(targetTextSchema.safeParse({ text: '菜单', reading: 'càidān' }).success).toBe(true);
		expect(targetTextSchema.safeParse({ text: 'el perro', reading: null }).success).toBe(true);
		expect(targetTextSchema.safeParse({ text: 'el perro' }).success).toBe(true);
	});

	it('rejects empty text: a slot with nothing in it is not content', () => {
		expect(targetTextSchema.safeParse({ text: '', reading: null }).success).toBe(false);
	});
});

describe('generatedBatchSchema', () => {
	it('parses a well-formed batch', () => {
		const parsed = generatedBatchSchema.safeParse(validBatch);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.challenges).toHaveLength(7);
	});

	it('accepts an omitted optional field as well as an explicit null', () => {
		expect(generatedChallengeSchema.safeParse(validBatch.challenges[3]).success).toBe(true);
		expect(generatedChallengeSchema.safeParse(validBatch.challenges[0]).success).toBe(true);
	});

	it('rejects multiple choice without exactly three distractors', () => {
		const short = { ...validBatch.challenges[0], distractors: ['the cat', 'the bread'] };
		expect(generatedChallengeSchema.safeParse(short).success).toBe(false);
		const long = {
			...validBatch.challenges[1],
			distractors: [
				{ text: 'pagar', reading: null },
				{ text: 'probar', reading: null },
				{ text: 'servir', reading: null },
				{ text: 'comer', reading: null }
			]
		};
		expect(generatedChallengeSchema.safeParse(long).success).toBe(false);
	});

	it('has no correctIndex to get wrong: position is not part of the wire format', () => {
		const serialized = JSON.stringify(batchJsonSchema());
		expect(serialized).not.toContain('correctIndex');
		expect(serialized).not.toContain('direction');
	});

	it('lets a cloze begin or end at the blank, but never omit the answer', () => {
		const leading = {
			...validBatch.challenges[2],
			before: { text: '', reading: null }
		};
		expect(generatedChallengeSchema.safeParse(leading).success).toBe(true);
		const noAnswer = { ...validBatch.challenges[2], answer: { text: '', reading: null } };
		expect(generatedChallengeSchema.safeParse(noAnswer).success).toBe(false);
	});

	it('rejects an empty answers list on either typed type', () => {
		expect(
			generatedChallengeSchema.safeParse({ ...validBatch.challenges[3], answers: [] }).success
		).toBe(false);
		expect(
			generatedChallengeSchema.safeParse({ ...validBatch.challenges[4], answersNative: [] })
				.success
		).toBe(false);
	});

	it('rejects an unknown challenge type', () => {
		expect(generatedChallengeSchema.safeParse({ type: 'essay', promptNative: 'x' }).success).toBe(
			false
		);
	});

	it('round-trips a non-Latin-script batch with a reading on every target slot', () => {
		const zhBatch = {
			challenges: [
				{
					type: 'produce-mc',
					promptNative: 'the menu',
					correct: { text: '菜单', reading: 'càidān' },
					distractors: [
						{ text: '筷子', reading: 'kuàizi' },
						{ text: '服务员', reading: 'fúwùyuán' },
						{ text: '茶', reading: 'chá' }
					],
					instruction: null,
					itemIds: ['new:0'],
					explanation: null
				},
				{
					type: 'cloze',
					before: { text: '请给我一份', reading: 'Qǐng gěi wǒ yī fèn' },
					answer: { text: '菜单', reading: 'càidān' },
					after: { text: '。', reading: '.' },
					hintNative: 'Please give me a menu.',
					distractorWords: null,
					itemIds: ['new:0'],
					explanation: null
				},
				{
					type: 'translate-to-target',
					promptNative: 'the bill, please',
					answers: [{ text: '买单', reading: 'mǎidān' }],
					itemIds: ['new:1']
				}
			],
			newItems: [
				{ term: '菜单', meaning: 'the menu', romanization: 'càidān', notes: null },
				{ term: '买单', meaning: 'to pay the bill', romanization: 'mǎidān' }
			]
		};

		const parsed = generatedBatchSchema.safeParse(zhBatch);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.newItems[0].romanization).toBe('càidān');
		const produce = parsed.data.challenges[0];
		expect(produce.type === 'produce-mc' && produce.distractors.map((d) => d.reading)).toEqual([
			'kuàizi',
			'fúwùyuán',
			'chá'
		]);
	});

	it('tolerates a word bank of an unusual size rather than dropping the challenge', () => {
		// Size is enforced by the resolver, not the schema: a cosmetic defect must
		// not cost us a challenge we already paid for.
		const wonky = {
			...validBatch.challenges[2],
			distractorWords: [{ text: 'como', reading: null }]
		};
		expect(generatedChallengeSchema.safeParse(wonky).success).toBe(true);
	});

	describe('multiple-choice instruction', () => {
		it('accepts an instruction and round-trips it', () => {
			const withInstruction = { ...validBatch.challenges[0], instruction: 'Pick the best reply' };
			const parsed = generatedChallengeSchema.safeParse(withInstruction);
			expect(parsed.success).toBe(true);
			expect(parsed.success && parsed.data.type === 'recognize-mc' && parsed.data.instruction).toBe(
				'Pick the best reply'
			);
		});

		it('tolerates a null or omitted instruction', () => {
			expect(generatedChallengeSchema.safeParse(validBatch.challenges[0]).success).toBe(true);
			const withNull = { ...validBatch.challenges[0], instruction: null };
			expect(generatedChallengeSchema.safeParse(withNull).success).toBe(true);
		});

		it('the stored schema tolerates an absent instruction and accepts a present one', () => {
			const base = {
				id: 'c1',
				type: 'multiple-choice' as const,
				direction: 'toNative' as const,
				prompt: 'el perro',
				options: ['the dog', 'the cat', 'the bread', 'the house'] as [
					string,
					string,
					string,
					string
				],
				correctIndex: 0,
				itemIds: ['i1']
			};
			expect(multipleChoiceChallengeSchema.safeParse(base).success).toBe(true);
			expect(
				multipleChoiceChallengeSchema.safeParse({ ...base, instruction: 'Pick the best reply' })
					.success
			).toBe(true);
		});
	});

	it('stores an optional wordBankRomanization alongside the bank', () => {
		const base = {
			id: 'c1',
			type: 'cloze' as const,
			direction: 'toTarget' as const,
			sentence: '请给我一份___。',
			acceptedAnswers: ['菜单'],
			translationHint: 'Please give me a menu.',
			itemIds: ['i1']
		};
		expect(clozeChallengeSchema.safeParse(base).success).toBe(true);
		expect(
			clozeChallengeSchema.safeParse({
				...base,
				wordBank: ['菜单', '筷子'],
				wordBankRomanization: ['càidān', 'kuàizi']
			}).success
		).toBe(true);
	});

	describe('word-order', () => {
		const wordOrder = validBatch.challenges[5];

		it('needs at least two tiles to be a sentence to build', () => {
			expect(
				generatedChallengeSchema.safeParse({
					...wordOrder,
					words: [{ text: 'Yo', reading: null }]
				}).success
			).toBe(false);
		});

		it('treats distractorWords as optional, null or any length', () => {
			for (const distractorWords of [null, undefined, [], [{ text: 'x', reading: null }]]) {
				expect(
					generatedChallengeSchema.safeParse({ ...wordOrder, distractorWords }).success
				).toBe(true);
			}
		});

		it('carries no order field of its own: order is the array', () => {
			const serialized = JSON.stringify(batchJsonSchema());
			expect(serialized).not.toContain('correctOrder');
			expect(serialized).not.toContain('answerTokens');
		});

		it('stores shuffled tiles alongside the answer key', () => {
			const stored = {
				id: 'c1',
				type: 'word-order' as const,
				direction: 'toTarget' as const,
				prompt: 'I read a book.',
				tiles: ['libro.', 'Yo', 'un', 'leo'],
				answerTokens: ['Yo', 'leo', 'un', 'libro.'],
				answer: 'Yo leo un libro.',
				itemIds: ['i1']
			};
			expect(wordOrderChallengeSchema.safeParse(stored).success).toBe(true);
			expect(challengeSchema.safeParse(stored).success).toBe(true);
			expect(
				wordOrderChallengeSchema.safeParse({
					...stored,
					tilesRomanization: ['', '', '', ''],
					answerRomanization: 'x'
				}).success
			).toBe(true);
		});
	});

	describe('spot-error', () => {
		const spotError = validBatch.challenges[6];

		it('needs a sentence long enough to hide an error in', () => {
			expect(
				generatedChallengeSchema.safeParse({
					...spotError,
					words: [
						{ text: 'Yo', reading: null },
						{ text: 'leo', reading: null }
					]
				}).success
			).toBe(false);
		});

		it('rejects a negative or non-integer wrongPosition', () => {
			expect(generatedChallengeSchema.safeParse({ ...spotError, wrongPosition: -1 }).success).toBe(
				false
			);
			expect(generatedChallengeSchema.safeParse({ ...spotError, wrongPosition: 1.5 }).success).toBe(
				false
			);
		});

		it('leaves the overshooting position to the resolver, not the schema', () => {
			// A position past the end is a structural failure the resolver drops:
			// the schema cannot see the array length from inside the field.
			expect(generatedChallengeSchema.safeParse({ ...spotError, wrongPosition: 99 }).success).toBe(
				true
			);
		});

		it('stores the corrupted sentence and the word that belonged there', () => {
			const stored = {
				id: 'c1',
				type: 'spot-error' as const,
				direction: 'toNative' as const,
				tokens: ['Yo', 'bebo', 'un', 'libro.'],
				correctIndex: 1,
				intendedWord: 'leo',
				correctedSentence: 'Yo leo un libro.',
				meaning: 'I read a book.',
				itemIds: ['i1']
			};
			expect(spotErrorChallengeSchema.safeParse(stored).success).toBe(true);
			expect(challengeSchema.safeParse(stored).success).toBe(true);
		});
	});

	it('rejects match-pairs: it is generated locally, never by the model', () => {
		const matchPairs = {
			type: 'match-pairs',
			direction: 'toNative',
			pairs: [
				{ a: 'perro', b: 'dog' },
				{ a: 'gato', b: 'cat' }
			],
			itemIds: ['i1', 'i2']
		};
		expect(generatedChallengeSchema.safeParse(matchPairs).success).toBe(false);
		// ...but the stored-challenge schema does accept it.
		expect(challengeSchema.safeParse({ ...matchPairs, id: 'c1' }).success).toBe(true);
	});
});

describe('batchJsonSchema', () => {
	const schema = batchJsonSchema();
	const serialized = JSON.stringify(schema);

	it('contains no unresolved $refs or $defs', () => {
		// TargetText appears in almost every wire type; it must still be inlined.
		expect(serialized).not.toContain('$ref');
		expect(serialized).not.toContain('$defs');
		expect(serialized).not.toContain('definitions');
	});

	it('uses anyOf rather than the unsupported oneOf/prefixItems', () => {
		expect(serialized).not.toContain('oneOf');
		expect(serialized).not.toContain('prefixItems');
		const challenges = schema.properties as Record<string, Record<string, never>>;
		expect(JSON.stringify(challenges.challenges)).toContain('anyOf');
	});

	it('is strict-mode ready: every object seals and requires all properties', () => {
		const visit = (node: unknown): void => {
			if (Array.isArray(node)) {
				node.forEach(visit);
				return;
			}
			if (!node || typeof node !== 'object') return;
			const obj = node as Record<string, unknown>;
			const properties = obj.properties as Record<string, unknown> | undefined;
			if (properties) {
				expect(obj.additionalProperties).toBe(false);
				expect(obj.required).toEqual(Object.keys(properties));
			}
			Object.values(obj).forEach(visit);
		};
		visit(schema);
	});

	it('describes both envelope arrays at the top level', () => {
		expect(schema.type).toBe('object');
		expect(Object.keys(schema.properties as object)).toEqual(['challenges', 'newItems']);
	});

	it('offers every wire type and the reading slot to the model', () => {
		for (const type of [
			'recognize-mc',
			'produce-mc',
			'cloze',
			'translate-to-target',
			'translate-to-native',
			'word-order',
			'spot-error'
		]) {
			expect(serialized).toContain(type);
		}
		expect(serialized).toContain('reading');
		const newItems = (schema.properties as Record<string, Record<string, JsonNode>>).newItems;
		const itemProps = (newItems.items as JsonNode).properties as object;
		expect(Object.keys(itemProps)).toContain('romanization');
	});

	it('leaves match-pairs out of the generation schema entirely', () => {
		// Pairs (and their aRom/bRom) are built locally and never cost tokens.
		expect(serialized).not.toContain('aRom');
		expect(serialized).not.toContain('pairs');
	});
});
