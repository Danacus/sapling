/**
 * The wire envelopes, and the strictness pass that makes them acceptable as
 * `response_format` payloads.
 */

import { describe, expect, it } from 'vitest';

import {
	annotatedTextJsonSchema,
	annotatedTextSchema,
	generatedTextJsonSchema,
	generatedTextSchema
} from './schemas';

describe('generatedTextSchema', () => {
	it('accepts a text whose optional annotations are null', () => {
		const parsed = generatedTextSchema.safeParse({
			title: 'Una mesa',
			sentences: [{ text: 'Hola.', reading: null, translation: null }],
			glossary: [{ term: 'hola', reading: null, meaning: 'hello' }]
		});
		expect(parsed.success).toBe(true);
	});

	it('accepts them missing entirely, which is the other thing models do', () => {
		const parsed = generatedTextSchema.safeParse({
			title: 'Una mesa',
			sentences: [{ text: 'Hola.' }],
			glossary: []
		});
		expect(parsed.success).toBe(true);
	});

	it('refuses a sentence with no text and a text with no title', () => {
		expect(
			generatedTextSchema.safeParse({ title: 'T', sentences: [{ text: '' }], glossary: [] }).success
		).toBe(false);
		expect(generatedTextSchema.safeParse({ title: '', sentences: [], glossary: [] }).success).toBe(
			false
		);
	});
});

describe('annotatedTextSchema', () => {
	it('lets the model decline the title the learner already gave', () => {
		const parsed = annotatedTextSchema.safeParse({
			title: null,
			sentences: [{ reading: null, translation: 'Hello.' }],
			glossary: []
		});
		expect(parsed.success).toBe(true);
	});

	it('has no place for the sentence text: that never comes back', () => {
		const parsed = annotatedTextSchema.parse({
			title: null,
			sentences: [{ reading: null, translation: 'Hello.', text: 'Hola.' }],
			glossary: []
		});
		expect(parsed.sentences[0]).not.toHaveProperty('text');
	});
});

describe('the JSON Schema projections', () => {
	it('lists every property as required, as strict structured outputs want', () => {
		const schema = generatedTextJsonSchema();
		expect(schema.required).toEqual(['title', 'sentences', 'glossary']);
		expect(schema.additionalProperties).toBe(false);
	});

	it('reaches into array items too', () => {
		const properties = generatedTextJsonSchema().properties as Record<
			string,
			{ items?: Record<string, unknown> }
		>;
		expect(properties.sentences.items?.required).toEqual(['text', 'reading', 'translation']);
		expect(properties.sentences.items?.additionalProperties).toBe(false);
		expect(properties.glossary.items?.required).toEqual(['term', 'reading', 'meaning']);
	});

	it('does the same for the annotate envelope', () => {
		const schema = annotatedTextJsonSchema();
		expect(schema.required).toEqual(['title', 'sentences', 'glossary']);
		const properties = schema.properties as Record<string, { items?: Record<string, unknown> }>;
		expect(properties.sentences.items?.required).toEqual(['reading', 'translation']);
	});

	it('drops $schema, which providers reject', () => {
		expect(generatedTextJsonSchema()).not.toHaveProperty('$schema');
		expect(annotatedTextJsonSchema()).not.toHaveProperty('$schema');
	});
});
