import { describe, expect, it } from 'vitest';
import type { Profile } from '$lib/types';
import { TASK_KINDS } from './registry';
import type { TaskInput, TaskKind } from './registry';
import { readingsTask } from './kinds/readings';
import { topUpTask } from './kinds/top-up';

const profile: Profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: [],
	dailyGoal: 10
} as unknown as Profile;

/** One well-formed input per kind, so every `title` can be called. */
const FAKE_INPUTS: { [K in TaskKind]: TaskInput<K> } = {
	'top-up': { profile, topic: 'at the market' },
	readings: { targetLanguage: 'Chinese', free: [], fromModel: [] },
	'read-generate': { profile, vocabulary: [], focus: [] },
	'read-annotate': { profile, vocabulary: [], sentences: ['Hola.'] },
	'tts-model': undefined
};

describe('TASK_KINDS', () => {
	it('every kind has a title, a run, a summary and a serial flag', () => {
		for (const [name, def] of Object.entries(TASK_KINDS)) {
			expect(typeof def.title, name).toBe('function');
			expect(typeof def.run, name).toBe('function');
			expect(typeof def.summary, name).toBe('function');
			expect(typeof def.serial, name).toBe('boolean');
		}
	});

	it('every kind titles a fake input without throwing, in the learner’s terms', () => {
		for (const kind of Object.keys(TASK_KINDS) as TaskKind[]) {
			const def = TASK_KINDS[kind] as { title(input: unknown): string };
			const title = def.title(FAKE_INPUTS[kind]);
			expect(title, kind).toMatch(/\S/);
		}
	});

	it('names the same kinds the fake-input table does', () => {
		expect(Object.keys(TASK_KINDS).sort()).toEqual(Object.keys(FAKE_INPUTS).sort());
	});
});

describe('top-up summary', () => {
	const base = { usage: { promptTokens: 0, completionTokens: 0 }, mock: true, items: [] };
	it('counts what landed', () => {
		expect(
			topUpTask.summary({ ...base, addedChallenges: 1, failedRequests: 0, args: {} } as never)
		).toBe('1 challenge added');
		expect(
			topUpTask.summary({ ...base, addedChallenges: 8, failedRequests: 0, args: {} } as never)
		).toBe('8 challenges added');
	});
	it('mentions failed requests only when there were some', () => {
		expect(
			topUpTask.summary({ ...base, addedChallenges: 6, failedRequests: 2, args: {} } as never)
		).toBe('6 challenges added — 2 requests failed');
	});
	it('titles by topic', () => {
		expect(topUpTask.title({ profile })).toBe('New lesson');
		expect(topUpTask.title({ profile, topic: 'hotels' })).toBe('New lesson · hotels');
	});
});

describe('readings summary', () => {
	it('says where the readings came from', () => {
		expect(readingsTask.summary({ free: 3, fromModel: 0, patched: [] })).toBe('Added 3 readings');
		expect(readingsTask.summary({ free: 0, fromModel: 1, patched: [] })).toBe('Added 1 reading');
		expect(readingsTask.summary({ free: 2, fromModel: 1, patched: [] })).toBe(
			'Added 3 readings (1 from the model)'
		);
	});
});
