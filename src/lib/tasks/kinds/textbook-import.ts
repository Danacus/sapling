/**
 * `textbook-import` — a whole book's pages read by a vision model and put
 * together into its chapters, for the learner to review.
 *
 * A task because it is a call per page, and a book is a hundred pages or more:
 * minutes of work the composer must not freeze for. It **saves nothing**: what
 * it produces is the book's chapters — sections, speakers, vocabulary — which
 * land in the Textbook drawer's review, and only the learner's Import there
 * stores the book. Like `captions`, a reload loses an unimported draft.
 *
 * Pages are rendered and read three at a time and kept in page order. **A page
 * that fails does not fail the book**: it is listed, the rest are read, and the
 * review says which are missing — a hundred good pages are not thrown away for
 * one the model could not read. Only every page failing fails the task, with
 * the first page's error. A cancel stops at once.
 */

import { assembleTextbook } from '$lib/db';
import type { Chapter, LearnerProfile } from '$lib/db/generated/index';
import { openPages, transcribePage } from '$lib/textbook';
import type { TextbookPage } from '$lib/textbook';
import type { TaskKindDef } from '../types';

/** Pages read at once: the same three a page's translations use. */
const CONCURRENCY = 3;

export interface TextbookImportInput {
	profile: LearnerProfile;
	/** One PDF, or the page images in order. Kept for Retry, like any input. */
	files: File[];
	/** Pages to read, from 1, inclusive: the whole book unless the learner narrowed it. */
	from: number;
	to: number;
	/** The vision model; blank is the learner's own. */
	model?: string;
	/** What the tray calls it: the file's name. */
	name: string;
}

export interface TextbookImportResult {
	chapters: Chapter[];
	name: string;
	/** How many pages were read. */
	pages: number;
	/** The pages (numbered in the file, from 1) the model could not read. */
	failed: number[];
}

export const textbookImportTask = {
	// One at a time: they spend the same key's rate limit, and a learner
	// reviews one book at a time anyway.
	serial: true,

	title(input) {
		const pages = input.to > input.from ? `pp. ${input.from}–${input.to}` : `p. ${input.from}`;
		return `Reading ${input.name}, ${pages}`;
	},

	async run(input, ctx) {
		ctx.step('open', 'Opening the book');
		const source = await openPages(input.files);
		const wanted: number[] = [];
		for (let n = input.from; n <= Math.min(input.to, source.count); n++) wanted.push(n);
		if (wanted.length === 0) {
			source.close();
			throw new Error('Those pages are not in the file.');
		}

		ctx.step('read', `Reading ${wanted.length} page${wanted.length === 1 ? '' : 's'}`);
		const pages: (TextbookPage | undefined)[] = new Array(wanted.length);
		const failed: { page: number; error: unknown }[] = [];
		let next = 0;
		let done = 0;
		ctx.progress(0, wanted.length, 'pages');
		try {
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
					while (next < wanted.length && !ctx.signal.aborted) {
						const at = next++;
						try {
							const image = await source.render(wanted[at]);
							pages[at] = await transcribePage(
								{ profile: input.profile, image, page: at + 1 },
								{ signal: ctx.signal, model: input.model }
							);
						} catch (error) {
							// A cancel ends the book; anything else costs this page alone.
							ctx.signal.throwIfAborted();
							failed.push({ page: wanted[at], error });
						}
						ctx.progress(++done, wanted.length, 'pages');
					}
				})
			);
		} finally {
			source.close();
		}
		ctx.signal.throwIfAborted();
		const read = pages.filter((page): page is TextbookPage => page !== undefined);
		if (read.length === 0) {
			const first = failed.sort((a, b) => a.page - b.page)[0]?.error;
			throw first instanceof Error ? first : new Error('No page could be read.');
		}

		ctx.step('assemble', 'Putting the chapters together');
		const chapters = await assembleTextbook(read);
		if (chapters.length === 0) {
			throw new Error('There is nothing in the target language on those pages.');
		}
		return {
			chapters,
			name: input.name,
			pages: wanted.length,
			failed: failed.map((f) => f.page).sort((a, b) => a - b)
		};
	},

	summary(result) {
		const chapters = result.chapters.length;
		const missing = result.failed.length
			? ` · ${result.failed.length} page${result.failed.length === 1 ? '' : 's'} unread`
			: '';
		return `${chapters} chapter${chapters === 1 ? '' : 's'} ready to review${missing}`;
	}
} satisfies TaskKindDef<TextbookImportInput, TextbookImportResult>;
