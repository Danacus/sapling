import { describe, expect, it } from 'vitest';
import {
	batchJsonSchema,
	challengeSchema,
	generatedBatchSchema,
	generatedChallengeSchema
} from './schemas';

type JsonNode = Record<string, unknown>;

const validBatch = {
	challenges: [
		{
			type: 'multiple-choice',
			direction: 'toNative',
			prompt: 'el perro',
			options: ['the dog', 'the cat', 'the bread', 'the house'],
			correctIndex: 0,
			itemIds: ['i1'],
			explanation: null
		},
		{
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Yo ___ un libro.',
			acceptedAnswers: ['leo'],
			wordBank: ['leo', 'como', 'bebo', 'corro'],
			translationHint: 'I read a book.',
			itemIds: ['new:0'],
			explanation: 'leer -> leo'
		},
		{
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'the water is cold',
			acceptedAnswers: ['el agua está fría', 'el agua esta fria'],
			itemIds: ['i2']
		}
	],
	newItems: [{ term: 'leer', meaning: 'to read', notes: null }]
};

describe('generatedBatchSchema', () => {
	it('parses a well-formed batch', () => {
		const parsed = generatedBatchSchema.safeParse(validBatch);
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.challenges).toHaveLength(3);
	});

	it('accepts an omitted optional field as well as an explicit null', () => {
		expect(generatedChallengeSchema.safeParse(validBatch.challenges[2]).success).toBe(true);
		expect(generatedChallengeSchema.safeParse(validBatch.challenges[0]).success).toBe(true);
	});

	it('rejects multiple-choice without exactly four options', () => {
		const bad = { ...validBatch.challenges[0], options: ['a', 'b', 'c'] };
		expect(generatedChallengeSchema.safeParse(bad).success).toBe(false);
	});

	it('rejects an out-of-range correctIndex', () => {
		const bad = { ...validBatch.challenges[0], correctIndex: 7 };
		expect(generatedChallengeSchema.safeParse(bad).success).toBe(false);
	});

	it('rejects a cloze sentence without a ___ blank', () => {
		const bad = { ...validBatch.challenges[1], sentence: 'Yo leo un libro.' };
		expect(generatedChallengeSchema.safeParse(bad).success).toBe(false);
	});

	it('rejects an empty acceptedAnswers list', () => {
		const bad = { ...validBatch.challenges[2], acceptedAnswers: [] };
		expect(generatedChallengeSchema.safeParse(bad).success).toBe(false);
	});

	it('rejects an unknown challenge type', () => {
		expect(generatedChallengeSchema.safeParse({ type: 'essay', direction: 'toTarget' }).success)
			.toBe(false);
	});

	it('round-trips a non-Latin-script batch with every romanization field', () => {
		const zhBatch = {
			challenges: [
				{
					type: 'multiple-choice',
					direction: 'toTarget',
					prompt: 'the menu',
					promptRomanization: null,
					options: ['菜单', '筷子', '服务员', '茶'],
					optionsRomanization: ['càidān', 'kuàizi', 'fúwùyuán', 'chá'],
					correctIndex: 0,
					itemIds: ['new:0'],
					explanation: null
				},
				{
					type: 'cloze',
					direction: 'toTarget',
					sentence: '请给我一份___。',
					sentenceRomanization: 'Qǐng gěi wǒ yī fèn càidān.',
					acceptedAnswers: ['菜单', 'càidān', 'caidan'],
					wordBank: null,
					translationHint: 'Please give me a menu.',
					itemIds: ['new:0'],
					explanation: null
				},
				{
					type: 'typed-translation',
					direction: 'toTarget',
					prompt: 'the bill, please',
					promptRomanization: null,
					acceptedAnswers: ['买单', 'mǎidān', 'maidan'],
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
		const mc = parsed.data.challenges[0];
		expect(mc.type === 'multiple-choice' && mc.optionsRomanization).toEqual([
			'càidān',
			'kuàizi',
			'fúwùyuán',
			'chá'
		]);
	});

	it('keeps a Latin-script batch valid with the romanization fields absent', () => {
		// Latin-script lessons omit the keys entirely rather than sending nulls.
		expect(generatedBatchSchema.safeParse(validBatch).success).toBe(true);
	});

	it('tolerates a misaligned optionsRomanization rather than dropping the challenge', () => {
		// Alignment is enforced by the resolver, not the schema: a cosmetic
		// defect must not cost us a challenge we already paid for.
		const wonky = { ...validBatch.challenges[0], optionsRomanization: ['a', 'b'] };
		expect(generatedChallengeSchema.safeParse(wonky).success).toBe(true);
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

	it('offers every romanization field to the model', () => {
		expect(serialized).toContain('promptRomanization');
		expect(serialized).toContain('optionsRomanization');
		expect(serialized).toContain('sentenceRomanization');
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
