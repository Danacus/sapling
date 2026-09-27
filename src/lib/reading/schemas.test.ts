/**
 * The wire envelopes, and the strictness pass that makes them acceptable as
 * `response_format` payloads.
 */

import { describe, expect, it } from 'vitest';

import {
	generatedTextJsonSchema,
	generatedTextSchema,
	glossEntrySchema,
	lineTranslationJsonSchema,
	lineTranslationSchema,
	lookedUpWordJsonSchema
} from './schemas';

describe('generatedTextSchema', () => {
	it('accepts a title and its paragraphs', () => {
		const parsed = generatedTextSchema.safeParse({
			title: 'Una mesa',
			paragraphs: ['Hola. Adiós.', 'Bien.']
		});
		expect(parsed.success).toBe(true);
	});

	it('has no place for readings, translations or a glossary: a text is only the text', () => {
		const parsed = generatedTextSchema.parse({
			title: 'Una mesa',
			paragraphs: ['Hola.'],
			glossary: [{ term: 'hola', meaning: 'hello' }]
		});
		expect(parsed).not.toHaveProperty('glossary');
	});

	it('refuses a text with no title or no paragraph list', () => {
		expect(generatedTextSchema.safeParse({ title: '', paragraphs: [] }).success).toBe(false);
		expect(generatedTextSchema.safeParse({ title: 'T' }).success).toBe(false);
	});
});

describe('glossEntrySchema', () => {
	it('accepts a null reading, as a Latin-script word has', () => {
		expect(glossEntrySchema.safeParse({ term: 'hola', reading: null, meaning: 'hi' }).success).toBe(
			true
		);
	});
});

describe('lineTranslationSchema', () => {
	it('is one translation and nothing about it', () => {
		const parsed = lineTranslationSchema.parse({ translation: 'Hello.', notes: 'informal' });
		expect(parsed).toEqual({ translation: 'Hello.' });
	});

	it('refuses an empty translation', () => {
		expect(lineTranslationSchema.safeParse({ translation: '' }).success).toBe(false);
	});
});

describe('the JSON Schema projections', () => {
	it('lists every property as required, as strict structured outputs want', () => {
		const schema = generatedTextJsonSchema();
		expect(schema.required).toEqual(['title', 'paragraphs']);
		expect(schema.additionalProperties).toBe(false);
	});

	it('does the same for the lookup envelope', () => {
		const schema = lookedUpWordJsonSchema();
		expect(schema.required).toEqual(['term', 'reading', 'meaning', 'explanation']);
		expect(schema.additionalProperties).toBe(false);
	});

	it('does the same for the translate envelope', () => {
		const schema = lineTranslationJsonSchema();
		expect(schema.required).toEqual(['translation']);
		expect(schema.additionalProperties).toBe(false);
	});

	it('drops $schema, which providers reject', () => {
		expect(generatedTextJsonSchema()).not.toHaveProperty('$schema');
		expect(lookedUpWordJsonSchema()).not.toHaveProperty('$schema');
		expect(lineTranslationJsonSchema()).not.toHaveProperty('$schema');
	});
});
