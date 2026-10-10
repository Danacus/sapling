/**
 * The check screen's decisions: the step rule, the repeat filter, what the
 * model is told to leave out, and one grid fetched — against a scripted batch
 * for the refetch rule, and through the real wasm mock for the whole path,
 * whose easier step backs into words already shown so the filter has
 * something to drop.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadWasmCore } from '$lib/db/backend.testing';
import type { SuggestedWord, WordBatch, WordBatchArgs } from '$lib/llm';
import {
	CHECK_COUNT,
	EXCLUDE_LIMIT,
	GRID_SIZE,
	MAX_FETCHES,
	STARTER_COUNT,
	byIntroduction,
	excludeTerms,
	fetchGrid,
	firstCheck,
	freshWords,
	nextStep
} from './check';

beforeAll(loadWasmCore);

const profile = { nativeLanguage: 'English', targetLanguage: 'Spanish' };

function words(...terms: string[]): SuggestedWord[] {
	return terms.map((term) => ({ term, meaning: `(${term})` }));
}

describe('nextStep', () => {
	it('steps harder from 70% tapped, easier under 30%, else stays', () => {
		expect(nextStep(14, 20)).toBe('harder');
		expect(nextStep(20, 20)).toBe('harder');
		expect(nextStep(13, 20)).toBe('same');
		expect(nextStep(6, 20)).toBe('same');
		expect(nextStep(5, 20)).toBe('easier');
		expect(nextStep(0, 20)).toBe('easier');
	});

	it('stays put after an empty grid', () => {
		expect(nextStep(0, 0)).toBe('same');
	});
});

describe('freshWords', () => {
	it('drops what is taken and repeats within the batch, by card key', () => {
		const batch = [
			...words(' Casa ', 'perro', 'gato', 'PERRO'),
			{ term: '长', meaning: 'to grow', romanization: 'zhǎng' },
			{ term: '长', meaning: 'long', romanization: 'cháng' }
		];
		const taken = [{ term: 'casa' }, { term: '长', romanization: 'cháng' }];
		expect(freshWords(batch, taken).map((w) => [w.term, w.romanization])).toEqual([
			['perro', undefined],
			['gato', undefined],
			['长', 'zhǎng']
		]);
	});

	it('treats a stored word without a reading as every reading of it', () => {
		const batch = [{ term: '长', meaning: 'long', romanization: 'cháng' }];
		expect(freshWords(batch, [{ term: '长', romanization: null }])).toEqual([]);
	});

	it('keeps the first `limit` survivors in order', () => {
		const batch = words(...Array.from({ length: 30 }, (_, i) => `w${i}`));
		const fresh = freshWords(batch, words('w0'));
		expect(fresh).toHaveLength(GRID_SIZE);
		expect(fresh[0]?.term).toBe('w1');
		expect(freshWords(batch, [], 3).map((w) => w.term)).toEqual(['w0', 'w1', 'w2']);
	});
});

describe('firstCheck', () => {
	it('opens an empty library at the most common words, any other at the same step', () => {
		expect(firstCheck([])).toBe('start');
		expect(firstCheck([{ term: 'casa', introducedAt: 1 }])).toBe('same');
	});
});

describe('byIntroduction', () => {
	it('puts the newest library word last, so it ends `exclude`', () => {
		const library = [
			{ term: 'c', introducedAt: 30, romanization: null },
			{ term: 'a', introducedAt: 10 },
			{ term: 'b', introducedAt: 20 }
		];
		expect(byIntroduction(library)).toEqual([
			{ term: 'a', romanization: undefined },
			{ term: 'b', romanization: undefined },
			{ term: 'c', romanization: null }
		]);
	});
});

describe('excludeTerms', () => {
	it('keeps each term once, at its last place, without blanks', () => {
		expect(excludeTerms([' casa ', 'perro', '', '  ', 'Casa', 'gato', 'PERRO'])).toEqual([
			'Casa',
			'gato',
			'PERRO'
		]);
	});

	it('keeps only the newest terms past the cap', () => {
		const terms = Array.from({ length: EXCLUDE_LIMIT + 500 }, (_, i) => `w${i}`);
		const exclude = excludeTerms(terms);
		expect(exclude).toHaveLength(EXCLUDE_LIMIT);
		expect(exclude[0]).toBe('w500');
		expect(exclude.at(-1)).toBe(`w${EXCLUDE_LIMIT + 499}`);
	});
});

describe('fetchGrid', () => {
	const args = { profile, wordCount: 0, mode: 'check' as const, step: 'same' as const };
	const many = (prefix: string, n: number) =>
		words(...Array.from({ length: n }, (_, i) => `${prefix}${i}`));

	function scripted(...replies: (SuggestedWord[] | Error)[]) {
		const asked: WordBatchArgs[] = [];
		const fetchBatch = async (request: WordBatchArgs): Promise<WordBatch> => {
			asked.push(request);
			const reply = replies[asked.length - 1] ?? [];
			if (reply instanceof Error) throw reply;
			return { words: reply };
		};
		return { asked, fetchBatch };
	}

	it('stops after one call when it fills the grid', async () => {
		const { asked, fetchBatch } = scripted(many('w', 30), many('v', 30));
		const grid = await fetchGrid(
			{ args, library: [], shown: [], limit: GRID_SIZE, count: CHECK_COUNT },
			{},
			fetchBatch
		);
		expect(grid.map((w) => w.term)).toEqual(many('w', GRID_SIZE).map((w) => w.term));
		expect(asked).toHaveLength(1);
		expect(asked[0]?.count).toBe(CHECK_COUNT);
	});

	it('excludes the library, then the run, then every earlier reply', async () => {
		const library = words('a', 'b');
		const shown = words('c', 'A');
		const { asked, fetchBatch } = scripted(words('a', 'd', 'e'), words('d', 'f'), many('w', 30));
		await fetchGrid({ args, library, shown, limit: GRID_SIZE, count: CHECK_COUNT }, {}, fetchBatch);
		// `A` was shown after `a` was added, so it takes `a`'s place.
		expect(asked.map((request) => request.exclude)).toEqual([
			['b', 'c', 'A'],
			['b', 'c', 'a', 'd', 'e'],
			['b', 'c', 'a', 'e', 'd', 'f']
		]);
	});

	it('fills across calls and gives up short after three', async () => {
		const library = words('a', 'b', 'c');
		const { asked, fetchBatch } = scripted(
			words('a', 'b', 'f'),
			words('f', 'g', 'a'),
			words('b', 'h'),
			many('never', 30)
		);
		const grid = await fetchGrid(
			{ args, library, shown: [], limit: GRID_SIZE, count: CHECK_COUNT },
			{},
			fetchBatch
		);
		expect(grid.map((w) => w.term)).toEqual(['f', 'g', 'h']);
		expect(asked).toHaveLength(MAX_FETCHES);
	});

	it('takes only what the grid still has room for', async () => {
		const { asked, fetchBatch } = scripted(many('w', 15), many('v', 15));
		const grid = await fetchGrid(
			{ args, library: [], shown: [], limit: GRID_SIZE, count: CHECK_COUNT },
			{},
			fetchBatch
		);
		expect(grid).toHaveLength(GRID_SIZE);
		expect(grid.at(-1)?.term).toBe('v4');
		expect(asked).toHaveLength(2);
	});

	it('shows what it has when a later call fails, and fails with nothing', async () => {
		const kept = scripted(words('a', 'b'), new Error('offline'));
		const grid = await fetchGrid(
			{ args, library: [], shown: [], limit: GRID_SIZE, count: CHECK_COUNT },
			{},
			kept.fetchBatch
		);
		expect(grid.map((w) => w.term)).toEqual(['a', 'b']);
		expect(kept.asked).toHaveLength(2);

		const lost = scripted(words('a'), new Error('offline'));
		await expect(
			fetchGrid(
				{ args, library: words('a'), shown: [], limit: GRID_SIZE, count: CHECK_COUNT },
				{},
				lost.fetchBatch
			)
		).rejects.toThrow('offline');
	});

	it('sends a starter grid the library too', async () => {
		const { asked, fetchBatch } = scripted(many('w', STARTER_COUNT));
		await fetchGrid(
			{
				args: { profile, wordCount: 2, mode: 'starter', topic: 'food' },
				library: words('casa', 'agua'),
				shown: [],
				limit: STARTER_COUNT,
				count: STARTER_COUNT
			},
			{},
			fetchBatch
		);
		expect(asked).toHaveLength(1);
		expect(asked[0]?.exclude).toEqual(['casa', 'agua']);
	});

	it('moves a second run past the library through the real mock', async () => {
		const first = await fetchGrid({
			args: { ...args, step: 'start' },
			library: [],
			shown: [],
			limit: GRID_SIZE,
			count: CHECK_COUNT
		});
		expect(first).toHaveLength(GRID_SIZE);
		// A learner who added the first grid and, later, thirty words the mock
		// does not list opens at `same` after the last mock word they have, and
		// gets a full grid of new ones.
		const items = [
			...first.map((w, i) => ({ term: w.term, introducedAt: i })),
			...many('x', 30).map((w, i) => ({ term: w.term, introducedAt: 1000 + i }))
		];
		const grid = await fetchGrid({
			args: { ...args, step: firstCheck(items) },
			library: byIntroduction(items),
			shown: [],
			limit: GRID_SIZE,
			count: CHECK_COUNT
		});
		expect(grid).toHaveLength(GRID_SIZE);
		const had = new Set(first.map((w) => w.term));
		expect(grid.filter((w) => had.has(w.term))).toEqual([]);
	});

	it('filters the real mock’s repeats out of a run', async () => {
		const first = await fetchGrid({
			args: { ...args, step: 'start' },
			library: words('casa'),
			shown: [],
			limit: GRID_SIZE,
			count: CHECK_COUNT
		});
		expect(first).toHaveLength(GRID_SIZE);
		expect(first.map((w) => w.term)).not.toContain('casa');

		// An easier step backs the mock up into the grid just shown.
		const next = await fetchGrid({
			args: { ...args, step: 'easier' },
			library: words('casa'),
			shown: first,
			limit: GRID_SIZE,
			count: CHECK_COUNT
		});
		const before = new Set(first.map((w) => w.term));
		expect(next).toHaveLength(GRID_SIZE);
		expect(next.filter((w) => before.has(w.term))).toEqual([]);
		expect(next.map((w) => w.term)).not.toContain('casa');
	});
});
