/**
 * The tool layer: the registry's own invariants, and each executor against an
 * in-memory {@link ToolContext}.
 *
 * No database and no model here — a tool is pure logic over the injected
 * context by construction, which is the point of the context existing. What is
 * worth asserting is what the model cannot be trusted to get right: that a word
 * the learner already has is never added twice, that a new word reaches the
 * store with a real FSRS card, and that every domain failure comes back as a
 * *result* the model can read rather than an exception that ends the turn.
 */

import { describe, expect, it } from 'vitest';

import type { KnowledgeItem } from '$lib/types';
import {
	ALREADY_PRESENT,
	ASSISTANT_TOOLS,
	MAX_LIMIT,
	addWordsTool,
	assistantToolByName,
	executeToolCall,
	listWordsTool,
	removeWordTool,
	toolDefsForClient,
	updateWordTool
} from './tools';
import type { ToolContext } from './tools';

const NOW = 1_700_000_000_000;

interface Fake {
	ctx: ToolContext;
	items: Map<string, KnowledgeItem>;
	upserts: KnowledgeItem[][];
	deleted: string[];
}

function item(term: string, meaning: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem {
	return {
		id: `seed-${term}`,
		kind: 'vocab',
		term,
		meaning,
		fsrsCard: { due: NOW },
		introducedAt: NOW - 1000,
		history: [],
		...extra
	};
}

function fake(seed: KnowledgeItem[] = []): Fake {
	const items = new Map(seed.map((row) => [row.id, row]));
	const upserts: KnowledgeItem[][] = [];
	const deleted: string[] = [];
	let minted = 0;

	return {
		items,
		upserts,
		deleted,
		ctx: {
			getAllItems: async () => [...items.values()],
			upsertItems: async (rows) => {
				upserts.push(rows);
				for (const row of rows) items.set(row.id, row);
			},
			deleteItem: async (id) => {
				deleted.push(id);
				items.delete(id);
			},
			newId: () => `new-${++minted}`,
			now: () => NOW
		}
	};
}

describe('the tool registry', () => {
	it('gives every tool a unique snake_case name', () => {
		const names = ASSISTANT_TOOLS.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
	});

	it('looks tools up by name and refuses unknown ones', () => {
		expect(assistantToolByName('add_words')).toBe(addWordsTool);
		expect(assistantToolByName('drop_database')).toBeUndefined();
	});

	it('projects every tool to a JSON-schema object', () => {
		const defs = toolDefsForClient();
		expect(defs.map((def) => def.name)).toEqual(ASSISTANT_TOOLS.map((tool) => tool.name));

		for (const def of defs) {
			expect(def.description.length).toBeGreaterThan(0);
			const schema = def.parameters as Record<string, unknown>;
			expect(schema.type).toBe('object');
			expect(schema.properties).toBeTypeOf('object');
			// `$schema` is meaningless inside a tool definition and some endpoints
			// reject it outright.
			expect(schema).not.toHaveProperty('$schema');
		}
	});
});

describe('add_words', () => {
	it('adds new words with an initialized card', async () => {
		const store = fake();
		const outcome = await addWordsTool.run(
			{
				words: [
					{
						term: ' hola ',
						meaning: 'hello',
						romanization: null,
						notes: null,
						kind: null
					},
					{
						term: 'adiós',
						meaning: 'goodbye',
						romanization: null,
						notes: 'formal',
						kind: null
					}
				]
			},
			store.ctx
		);

		expect(outcome.result).toEqual({ added: ['hola', 'adiós'], skipped: [] });
		expect(outcome.summary).toContain('hola');
		expect(store.upserts).toHaveLength(1);

		const added = store.upserts[0];
		expect(added.map((row) => row.term)).toEqual(['hola', 'adiós']);
		for (const row of added) {
			expect(row.fsrsCard).not.toBeNull();
			expect(row.kind).toBe('vocab');
			expect(row.introducedAt).toBe(NOW);
			expect(row.history).toEqual([]);
		}
		expect(added[1].notes).toBe('formal');
	});

	it('omits romanization and notes when they are blank', async () => {
		const store = fake();
		await addWordsTool.run(
			{
				words: [
					{
						term: 'gato',
						meaning: 'cat',
						romanization: '  ',
						notes: '',
						kind: 'vocab'
					}
				]
			},
			store.ctx
		);

		const added = store.upserts[0][0];
		expect(added).not.toHaveProperty('romanization');
		expect(added).not.toHaveProperty('notes');
	});

	it('skips words the learner already has, whatever the casing', async () => {
		const store = fake([item('Hola', 'hello')]);
		const outcome = await addWordsTool.run(
			{
				words: [
					{
						term: ' hola',
						meaning: 'hi',
						romanization: null,
						notes: null,
						kind: null
					},
					{
						term: 'perro',
						meaning: 'dog',
						romanization: null,
						notes: null,
						kind: null
					}
				]
			},
			store.ctx
		);

		expect(outcome.result).toEqual({
			added: ['perro'],
			skipped: [{ term: 'hola', reason: ALREADY_PRESENT }]
		});
		expect(store.upserts[0].map((row) => row.term)).toEqual(['perro']);
	});

	it('dedupes inside one batch too', async () => {
		const store = fake();
		const outcome = await addWordsTool.run(
			{
				words: [
					{
						term: 'casa',
						meaning: 'house',
						romanization: null,
						notes: null,
						kind: null
					},
					{
						term: 'CASA',
						meaning: 'home',
						romanization: null,
						notes: null,
						kind: null
					}
				]
			},
			store.ctx
		);

		expect(store.upserts[0]).toHaveLength(1);
		expect(outcome.result).toMatchObject({ added: ['casa'] });
	});

	it('writes nothing when every word is a duplicate', async () => {
		const store = fake([item('hola', 'hello')]);
		const outcome = await addWordsTool.run(
			{
				words: [
					{
						term: 'hola',
						meaning: 'hello',
						romanization: null,
						notes: null,
						kind: null
					}
				]
			},
			store.ctx
		);

		expect(store.upserts).toHaveLength(0);
		expect(outcome.summary).toContain('Nothing added');
	});

	/**
	 * The four combinations of "has a reading" across the stored card and the
	 * offered one. Only one of them is two words; the rest are one word twice,
	 * and the asymmetry is what keeps every collection written before homographs
	 * existed from forking an SRS history on a guess.
	 */
	describe('homographs', () => {
		const word = (term: string, meaning: string, romanization: string | null) => ({
			term,
			meaning,
			romanization,
			notes: null,
			kind: null
		});

		it('adds a second reading of a spelling the learner already has', async () => {
			const store = fake([item('长', 'long', { romanization: 'cháng' })]);
			const outcome = await addWordsTool.run(
				{ words: [word('长', 'to grow', 'zhǎng')] },
				store.ctx
			);

			expect(outcome.result).toMatchObject({ added: ['长'], skipped: [] });
			const added = store.upserts[0][0];
			expect(added.romanization).toBe('zhǎng');
			expect(added.id).not.toBe('seed-长');
		});

		it('skips a reading the learner already has, however it was spaced', async () => {
			const store = fake([item('自行车', 'bicycle', { romanization: 'zìxíngchē' })]);
			const outcome = await addWordsTool.run(
				{ words: [word('自行车', 'bike', 'zì xíng chē')] },
				store.ctx
			);

			expect(store.upserts).toHaveLength(0);
			expect(outcome.result).toMatchObject({
				skipped: [{ term: '自行车', reason: ALREADY_PRESENT }]
			});
		});

		it('skips a reading-less word beside a card that has a reading', async () => {
			const store = fake([item('长', 'long', { romanization: 'cháng' })]);
			const outcome = await addWordsTool.run({ words: [word('长', 'to grow', null)] }, store.ctx);

			expect(store.upserts).toHaveLength(0);
			expect(outcome.result).toMatchObject({
				skipped: [{ term: '长', reason: ALREADY_PRESENT }]
			});
		});

		it('skips a read word beside a card stored without one', async () => {
			const store = fake([item('长', 'long')]);
			const outcome = await addWordsTool.run(
				{ words: [word('长', 'to grow', 'zhǎng')] },
				store.ctx
			);

			expect(store.upserts).toHaveLength(0);
			expect(outcome.result).toMatchObject({
				skipped: [{ term: '长', reason: ALREADY_PRESENT }]
			});
		});

		it('separates two readings offered in one batch, and still folds a repeat', async () => {
			const store = fake();
			const outcome = await addWordsTool.run(
				{
					words: [
						word('长', 'long', 'cháng'),
						word('长', 'to grow', 'zhǎng'),
						word('长', 'lengthy', 'cháng'),
						word('长', 'either', null)
					]
				},
				store.ctx
			);

			expect(store.upserts[0].map((row) => row.romanization)).toEqual(['cháng', 'zhǎng']);
			expect(outcome.result).toMatchObject({
				added: ['长', '长'],
				skipped: [
					{ term: '长', reason: ALREADY_PRESENT },
					{ term: '长', reason: ALREADY_PRESENT }
				]
			});
		});
	});
});

describe('list_words', () => {
	const seeded = [
		item('hola', 'hello'),
		item('gato', 'cat', {
			romanization: 'GA-to',
			history: [{ at: NOW, grade: 3 }]
		}),
		item('perro', 'dog')
	];

	it('returns the whole list with review counts', async () => {
		const store = fake(seeded);
		const outcome = await listWordsTool.run({ query: null, limit: null }, store.ctx);

		expect(outcome.result).toMatchObject({ total: 3, showing: 3 });
		const entries = (outcome.result as { entries: { term: string; reviews: number }[] }).entries;
		expect(entries.map((entry) => entry.term)).toEqual(['hola', 'gato', 'perro']);
		expect(entries[1].reviews).toBe(1);
	});

	it('filters on term, meaning and romanization, case-insensitively', async () => {
		const store = fake(seeded);
		const byMeaning = await listWordsTool.run({ query: 'DOG', limit: null }, store.ctx);
		expect(byMeaning.result).toMatchObject({ total: 1 });

		const byRomanization = await listWordsTool.run({ query: 'ga-to', limit: null }, store.ctx);
		expect(byRomanization.result).toMatchObject({ total: 1 });
		expect(byRomanization.summary).toContain('ga-to');
	});

	it('clamps the limit at both ends', async () => {
		const many = Array.from({ length: MAX_LIMIT + 20 }, (_, i) =>
			item(`w${i}`, `m${i}`, { id: `id-${i}` })
		);
		const store = fake(many);

		const huge = await listWordsTool.run({ query: null, limit: 5000 }, store.ctx);
		expect(huge.result).toMatchObject({
			total: many.length,
			showing: MAX_LIMIT
		});

		const none = await listWordsTool.run({ query: null, limit: 0 }, store.ctx);
		expect(none.result).toMatchObject({ showing: 1 });
	});
});

describe('update_word', () => {
	it('merges the given fields and leaves card and history alone', async () => {
		const card = { due: NOW, reps: 4 };
		const store = fake([
			item('gato', 'dog', {
				notes: 'old note',
				fsrsCard: card,
				history: [{ at: NOW, grade: 3 }]
			})
		]);

		const outcome = await updateWordTool.run(
			{
				term: 'GATO ',
				fields: { term: null, meaning: 'cat', romanization: null, notes: '' }
			},
			store.ctx
		);

		expect(outcome.ok).not.toBe(false);
		const saved = store.upserts[0][0];
		expect(saved.id).toBe('seed-gato');
		expect(saved.meaning).toBe('cat');
		expect(saved).not.toHaveProperty('notes');
		expect(saved.fsrsCard).toBe(card);
		expect(saved.history).toHaveLength(1);
		expect(outcome.result).toMatchObject({ changed: ['meaning', 'notes'] });
	});

	it('reports an unknown word as a result, without writing', async () => {
		const store = fake([item('hola', 'hello')]);
		const outcome = await updateWordTool.run(
			{
				term: 'perro',
				fields: { term: null, meaning: 'dog', romanization: null, notes: null }
			},
			store.ctx
		);

		expect(outcome.ok).toBe(false);
		expect(outcome.result).toEqual({ error: 'no word "perro" in the list' });
		expect(store.upserts).toHaveLength(0);
	});

	it('treats a patch with nothing new in it as a failure', async () => {
		const store = fake([item('hola', 'hello')]);
		const outcome = await updateWordTool.run(
			{
				term: 'hola',
				fields: {
					term: null,
					meaning: 'hello',
					romanization: null,
					notes: null
				}
			},
			store.ctx
		);

		expect(outcome.ok).toBe(false);
		expect(store.upserts).toHaveLength(0);
	});

	it('refuses a spelling that names two words until it is told which', async () => {
		const store = fake([
			item('长', 'long', { id: 'chang', romanization: 'cháng' }),
			item('长', 'to grow', { id: 'zhang', romanization: 'zhǎng' })
		]);

		const ambiguous = await updateWordTool.run(
			{
				term: '长',
				romanization: null,
				fields: { term: null, meaning: 'lengthy', romanization: null, notes: null }
			},
			store.ctx
		);
		expect(ambiguous.ok).toBe(false);
		expect(String(ambiguous.summary)).toContain('cháng');
		expect(store.upserts).toHaveLength(0);

		const picked = await updateWordTool.run(
			{
				term: '长',
				romanization: 'zhǎng',
				fields: { term: null, meaning: 'to grow up', romanization: null, notes: null }
			},
			store.ctx
		);
		expect(picked.ok).not.toBe(false);
		expect(store.upserts[0][0].id).toBe('zhang');
	});

	it('refuses an edit that would walk one card onto another', async () => {
		const store = fake([
			item('长', 'long', { id: 'chang', romanization: 'cháng' }),
			item('长', 'to grow', { id: 'zhang', romanization: 'zhǎng' })
		]);

		const outcome = await updateWordTool.run(
			{
				term: '长',
				romanization: 'zhǎng',
				fields: { term: null, meaning: null, romanization: 'cháng', notes: null }
			},
			store.ctx
		);

		expect(outcome.ok).toBe(false);
		expect(String(outcome.summary)).toContain('collide');
		expect(store.upserts).toHaveLength(0);
	});

	it('lets a word keep its own reading while something else changes', async () => {
		const store = fake([item('长', 'long', { id: 'chang', romanization: 'cháng' })]);
		const outcome = await updateWordTool.run(
			{
				term: '长',
				romanization: null,
				fields: { term: null, meaning: 'lengthy', romanization: null, notes: null }
			},
			store.ctx
		);

		expect(outcome.ok).not.toBe(false);
		expect(store.upserts[0][0].meaning).toBe('lengthy');
	});
});

describe('remove_word', () => {
	it('deletes the matching word', async () => {
		const store = fake([item('hola', 'hello'), item('gato', 'cat')]);
		const outcome = await removeWordTool.run({ term: ' Hola ' }, store.ctx);

		expect(store.deleted).toEqual(['seed-hola']);
		expect(outcome.result).toEqual({ removed: 'hola' });
	});

	it('deletes nothing when the word is not there', async () => {
		const store = fake([item('hola', 'hello')]);
		const outcome = await removeWordTool.run({ term: 'perro' }, store.ctx);

		expect(store.deleted).toEqual([]);
		expect(outcome.ok).toBe(false);
		expect(outcome.result).toEqual({ error: 'no word "perro" in the list' });
	});

	it('deletes nothing while a spelling names two words', async () => {
		const store = fake([
			item('长', 'long', { id: 'chang', romanization: 'cháng' }),
			item('长', 'to grow', { id: 'zhang', romanization: 'zhǎng' })
		]);

		const ambiguous = await removeWordTool.run({ term: '长', romanization: null }, store.ctx);
		expect(ambiguous.ok).toBe(false);
		expect(store.deleted).toEqual([]);

		const picked = await removeWordTool.run({ term: '长', romanization: 'cháng' }, store.ctx);
		expect(picked.ok).not.toBe(false);
		expect(store.deleted).toEqual(['chang']);
	});
});

describe('executeToolCall', () => {
	it('runs a named tool with parsed arguments', async () => {
		const store = fake();
		const outcome = await executeToolCall(
			{
				name: 'add_words',
				arguments: '{"words":[{"term":"sí","meaning":"yes"}]}'
			},
			store.ctx
		);

		expect(outcome.result).toMatchObject({ added: ['sí'] });
		expect(store.items.size).toBe(1);
	});

	it('turns malformed argument JSON into a readable failure', async () => {
		const store = fake();
		const outcome = await executeToolCall({ name: 'add_words', arguments: '{oops' }, store.ctx);

		expect(outcome.ok).toBe(false);
		expect(outcome.result).toMatchObject({
			error: expect.stringContaining('not valid JSON')
		});
		expect(store.upserts).toHaveLength(0);
	});

	it('turns schema violations into a failure naming the field', async () => {
		const store = fake();
		const outcome = await executeToolCall(
			{
				name: 'add_words',
				arguments: '{"words":[{"term":"","meaning":"yes"}]}'
			},
			store.ctx
		);

		expect(outcome.ok).toBe(false);
		expect(String((outcome.result as { error: string }).error)).toContain('words.0.term');
	});

	it('refuses a tool that does not exist', async () => {
		const store = fake();
		const outcome = await executeToolCall({ name: 'wipe_list', arguments: '{}' }, store.ctx);

		expect(outcome.ok).toBe(false);
		expect(outcome.result).toEqual({ error: 'no tool named wipe_list' });
	});
});
