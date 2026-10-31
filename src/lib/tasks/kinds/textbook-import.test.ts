/**
 * The textbook import end to end in mock mode: the real wasm calls (the
 * fixture pages through the real parser and tidy), the real
 * `assembleTextbook` over an in-memory store, the real gloss call. Only the
 * drawing of a page is faked — node has no canvas.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend } from '$lib/db/backend.testing';
import type { TaskContext } from '../types';

const rendered: number[] = [];
vi.mock('$lib/textbook/render', () => ({
	isPdf: () => false,
	openPages: async (files: File[]) => ({
		count: files.length,
		render: async (n: number) => {
			rendered.push(n);
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

beforeEach(async () => {
	rendered.length = 0;
	setBackendForTesting(await makeTestBackend());
});

describe('textbook-import', () => {
	it('reads the chosen pages and assembles one lesson', async () => {
		const { ctx, steps, progress } = context();
		const result = await textbookImportTask.run(
			{
				profile: { nativeLanguage: 'English', targetLanguage: 'Chinese' },
				files: files(4),
				from: 2,
				to: 3,
				name: 'Book'
			},
			ctx
		);
		expect(rendered.sort()).toEqual([2, 3]);
		expect(steps).toEqual(['open', 'read', 'assemble']);
		expect(progress.at(-1)).toEqual([2, 2]);
		expect(result.pages).toBe(2);
		// Fixture page 1, then 2: tidied (no "A:", no spaces between hanzi, no "（1）").
		expect(result.draft.title).toBe('1 · 你好');
		expect(result.draft.segments.map((s) => s.text)).toEqual([
			'你好！',
			'你好！我叫王明。',
			'我叫安娜。你是学生吗？',
			'是，我是学生。',
			'他是老师吗？',
			'你是中国人吗？'
		]);
		// 学生 is listed twice; the second listing adds nothing it lacked.
		expect(result.draft.words.map((w) => w.term)).toEqual([
			'你好',
			'叫',
			'学生',
			'吗',
			'王明',
			'是',
			'老师'
		]);
		expect(result.unglossed).toBe(0);
		expect(textbookImportTask.summary(result)).toBe('6 lines and 7 words ready to review');
	});

	it('asks for meanings a list printed without them', async () => {
		const { ctx, steps } = context();
		const result = await textbookImportTask.run(
			{
				profile: { nativeLanguage: 'English', targetLanguage: 'Spanish' },
				files: files(2),
				from: 1,
				to: 2,
				name: 'Libro'
			},
			ctx
		);
		expect(steps).toEqual(['open', 'read', 'assemble', 'gloss']);
		expect(result.draft.words.map((w) => [w.term, w.notes, w.meaning])).toEqual([
			['café', 'el', '(meaning of "café")'],
			['leche', 'la', '(meaning of "leche")'],
			['desear', 'deseo, deseas, desea', '(meaning of "desear")'],
			['gracias', undefined, '(meaning of "gracias")'],
			['té', 'el', '(meaning of "té")'],
			['cuenta', 'la', '(meaning of "cuenta")']
		]);
		expect(result.unglossed).toBe(0);
	});

	it('refuses a range outside the file', async () => {
		const { ctx } = context();
		await expect(
			textbookImportTask.run(
				{
					profile: { nativeLanguage: 'English', targetLanguage: 'Chinese' },
					files: files(2),
					from: 5,
					to: 6,
					name: 'Book'
				},
				ctx
			)
		).rejects.toThrow('Those pages are not in the file.');
	});

	it('titles itself by file and pages', () => {
		const input = {
			profile: { nativeLanguage: 'English', targetLanguage: 'Chinese' },
			files: [],
			name: 'HSK 1'
		};
		expect(textbookImportTask.title({ ...input, from: 14, to: 21 })).toBe(
			'Reading HSK 1, pp. 14–21'
		);
		expect(textbookImportTask.title({ ...input, from: 14, to: 14 })).toBe('Reading HSK 1, p. 14');
	});
});
