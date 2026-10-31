/**
 * The textbook import end to end in mock mode: the real wasm calls (the
 * fixture pages through the real parser and tidy), the real `assembleTextbook`
 * over an in-memory store. Only the drawing of a page is faked — node has no
 * canvas — and, for one test, made to fail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend } from '$lib/db/backend.testing';
import type { TaskContext } from '../types';

const rendered: number[] = [];
let failOn: number | undefined;
vi.mock('$lib/textbook/render', () => ({
	isPdf: () => false,
	openPages: async (files: File[]) => ({
		count: files.length,
		render: async (n: number) => {
			rendered.push(n);
			if (n === failOn) throw new Error(`page ${n} is torn`);
			return 'data:image/jpeg;base64,AA==';
		},
		close: () => {}
	})
}));

const { textbookImportTask } = await import('./textbook-import');

function context(signal = new AbortController().signal) {
	const steps: string[] = [];
	const progress: [number, number][] = [];
	const ctx: TaskContext = {
		signal,
		step: (id) => steps.push(id),
		progress: (done, total) => progress.push([done, total])
	};
	return { ctx, steps, progress };
}

const files = (n: number) => Array.from({ length: n }, (_, i) => new File(['x'], `p${i + 1}.png`));
const chinese = { nativeLanguage: 'English', targetLanguage: 'Chinese' };

beforeEach(async () => {
	rendered.length = 0;
	failOn = undefined;
	setBackendForTesting(await makeTestBackend());
});

describe('textbook-import', () => {
	it('reads the book and assembles its chapters with their structure', async () => {
		const { ctx, steps, progress } = context();
		const result = await textbookImportTask.run(
			{ profile: chinese, files: files(2), from: 1, to: 2, name: 'Book' },
			ctx
		);
		expect(rendered.sort()).toEqual([1, 2]);
		expect(steps).toEqual(['open', 'read', 'assemble']);
		expect(progress.at(-1)).toEqual([2, 2]);
		expect(result.failed).toEqual([]);

		// Both fixture pages are lesson 1: one chapter, titled by its opening.
		expect(result.chapters).toHaveLength(1);
		const [chapter] = result.chapters;
		expect([chapter.label, chapter.title, chapter.firstPage, chapter.lastPage]).toEqual([
			'1',
			'你好',
			'8',
			'9'
		]);
		expect(chapter.sections.map((s) => [s.kind, s.heading ?? null])).toEqual([
			['dialogue', '在学校'],
			['words', 'New Words'],
			['words', 'Proper Noun'],
			['dialogue', null],
			['sentences', '疑问助词“吗” The Interrogative Particle “吗”'],
			['words', 'New Words']
		]);
		// Speakers kept — the "A:" of a dropped pinyin line included — and no
		// pinyin, translation or "A:" left in any line.
		expect(chapter.sections[0].lines).toEqual([
			{ speaker: 'A', text: '你好！' },
			{ speaker: 'B', text: '你好！我叫王明。' },
			{ speaker: 'A', text: '我叫安娜。你是学生吗？' }
		]);
		expect(chapter.sections[3]).toMatchObject({
			kind: 'dialogue',
			number: '2',
			lines: [{ speaker: 'B', text: '是，我是学生。' }]
		});
		expect(chapter.sections[1].words[0]).toEqual({
			term: '你好',
			notes: 'int.',
			meaning: 'hello',
			proper: false
		});
		expect(chapter.sections[4].lines.map((l) => l.text)).toEqual([
			'他是老师吗？',
			'你是中国人吗？'
		]);
		expect(textbookImportTask.summary(result)).toBe('1 chapter ready to review');
	});

	it('lists a page it could not read and keeps the rest', async () => {
		failOn = 2;
		const { ctx } = context();
		const result = await textbookImportTask.run(
			{ profile: chinese, files: files(3), from: 1, to: 3, name: 'Book' },
			ctx
		);
		expect(result.failed).toEqual([2]);
		expect(result.chapters.length).toBeGreaterThan(0);
		expect(textbookImportTask.summary(result)).toBe('1 chapter ready to review · 1 page unread');
	});

	it('fails only when no page could be read', async () => {
		failOn = 1;
		const { ctx } = context();
		await expect(
			textbookImportTask.run(
				{ profile: chinese, files: files(1), from: 1, to: 1, name: 'Book' },
				ctx
			)
		).rejects.toThrow('page 1 is torn');
	});

	it('refuses a range outside the file', async () => {
		const { ctx } = context();
		await expect(
			textbookImportTask.run(
				{ profile: chinese, files: files(2), from: 5, to: 6, name: 'Book' },
				ctx
			)
		).rejects.toThrow('Those pages are not in the file.');
	});

	it('titles itself by file and pages', () => {
		const input = { profile: chinese, files: [], name: 'HSK 1' };
		expect(textbookImportTask.title({ ...input, from: 1, to: 120 })).toBe(
			'Reading HSK 1, pp. 1–120'
		);
		expect(textbookImportTask.title({ ...input, from: 14, to: 14 })).toBe('Reading HSK 1, p. 14');
	});
});
