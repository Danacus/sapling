/**
 * The check screen's decisions: the step rule, the repeat filter, and one grid
 * fetched — against a scripted batch for the refetch rule, and through the
 * real wasm mock for the whole path, whose easier step backs into words
 * already shown so the filter has something to drop.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadWasmCore } from '$lib/db/backend.testing';
import type { SuggestedWord, WordBatch, WordBatchArgs } from '$lib/llm';
import {
	CHECK_COUNT,
	GRID_SIZE,
	MIN_GRID,
	RECENT_LIMIT,
	fetchGrid,
	firstCheck,
	freshWords,
	nextStep,
	recentTerms
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
	it('opens an empty library at the most common words, with nothing recent', () => {
		expect(firstCheck([])).toEqual({ step: 'start', seed: [] });
	});

	it('opens a library at the same step as its latest-added words', () => {
		const library = Array.from({ length: 80 }, (_, i) => ({
			term: `w${i}`,
			// Out of order, so the sort is what puts the newest last.
			introducedAt: i % 2 === 0 ? i : 1000 + i
		}));
		const { step, seed } = firstCheck(library);
		expect(step).toBe('same');
		expect(seed).toHaveLength(RECENT_LIMIT);
		// The 40 odd ones are newest; the newest of all comes last.
		expect(seed.slice(-40)).toEqual(library.filter((_, i) => i % 2 === 1).map((w) => w.term));
		expect(seed.at(-1)).toBe('w79');
		expect(firstCheck([{ term: 'casa', introducedAt: 1 }])).toEqual({
			step: 'same',
			seed: ['casa']
		});
	});
});

describe('recentTerms', () => {
	it('sends only the latest terms', () => {
		const shown = words(...Array.from({ length: 80 }, (_, i) => `w${i}`));
		const recent = recentTerms(shown);
		expect(recent).toHaveLength(RECENT_LIMIT);
		expect(recent[0]).toBe('w20');
		expect(recent.at(-1)).toBe('w79');
	});
});

describe('fetchGrid', () => {
	const args = { profile, wordCount: 0, mode: 'check' as const, step: 'same' as const };

	function scripted(...replies: SuggestedWord[][]) {
		const asked: WordBatchArgs[] = [];
		const fetchBatch = async (request: WordBatchArgs): Promise<WordBatch> => {
			asked.push(request);
			return { words: replies[asked.length - 1] ?? [] };
		};
		return { asked, fetchBatch };
	}

	it('shows the first batch when enough of it is new', async () => {
		const { asked, fetchBatch } = scripted(words(...Array.from({ length: 10 }, (_, i) => `w${i}`)));
		const grid = await fetchGrid(
			{ args, library: [], shown: [], limit: GRID_SIZE, count: CHECK_COUNT },
			{},
			fetchBatch
		);
		expect(grid).toHaveLength(10);
		expect(asked).toHaveLength(1);
		expect(asked[0]?.count).toBe(CHECK_COUNT);
	});

	it('fetches once more when too little survives, and never a third time', async () => {
		const library = words('a', 'b', 'c');
		const shown = words('d', 'e');
		const { asked, fetchBatch } = scripted(
			words('a', 'b', 'c', 'd', 'e', 'f'),
			words('f', 'g', 'a'),
			words('h', 'i', 'j', 'k', 'l', 'm', 'n', 'o')
		);
		const grid = await fetchGrid(
			{ args, library, shown, limit: GRID_SIZE, count: CHECK_COUNT },
			{},
			fetchBatch
		);
		expect(grid.map((w) => w.term)).toEqual(['f', 'g']);
		expect(grid.length).toBeLessThan(MIN_GRID);
		expect(asked).toHaveLength(2);
		// The second ask also names what the first one listed, so it moves on.
		expect(asked[0]?.recent).toEqual(['d', 'e']);
		expect(asked[1]?.recent).toEqual(['d', 'e', 'a', 'b', 'c', 'd', 'e', 'f']);
	});

	it('sends the seed ahead of what was shown', async () => {
		const { asked, fetchBatch } = scripted(words(...Array.from({ length: 10 }, (_, i) => `w${i}`)));
		await fetchGrid(
			{
				args,
				library: [],
				shown: words('d'),
				seed: ['a', 'b'],
				limit: GRID_SIZE,
				count: CHECK_COUNT
			},
			{},
			fetchBatch
		);
		expect(asked[0]?.recent).toEqual(['a', 'b', 'd']);
	});

	it('moves a second run past the library through the real mock', async () => {
		const library = words(...Array.from({ length: 30 }, (_, i) => `x${i}`));
		const first = await fetchGrid({
			args: { ...args, step: 'start' },
			library: [],
			shown: [],
			limit: 30,
			count: CHECK_COUNT
		});
		// A learner who already added the first thirty mock words opens at
		// `same` after them, and gets a full grid of new ones.
		const { step, seed } = firstCheck(first.map((w, i) => ({ term: w.term, introducedAt: i })));
		const grid = await fetchGrid({
			args: { ...args, step },
			library: [...library, ...first],
			shown: [],
			seed,
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
		expect(next.length).toBeGreaterThanOrEqual(MIN_GRID);
		expect(next.filter((w) => before.has(w.term))).toEqual([]);
		expect(next.map((w) => w.term)).not.toContain('casa');
	});
});
