import { describe, expect, it } from 'vitest';
import {
	batchJsonSchema,
	challengeSchema,
	generatedBatchSchema,
	generatedChallengeSchema
} from './schemas';

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
});
