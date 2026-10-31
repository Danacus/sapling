/**
 * `textbook-import` — one lesson's pages read by a vision model and put
 * together into a draft the learner reviews.
 *
 * A task because it is a page of model calls that take seconds each, and the
 * composer must not freeze while they run. It **saves nothing**: what it
 * produces is a draft — the lesson's title and its lines — which lands in the
 * Textbook drawer's review, and only the learner's Import there writes the
 * text. Words are added from the stored text afterwards, like any text's.
 * Like `captions`, a reload loses an unimported draft; re-running it is one
 * tap and costs a few cents.
 *
 * Pages are rendered and read three at a time, in page order in the result.
 * One page failing fails the task — a lesson with its middle page missing is
 * not a lesson — and the tray's Retry re-reads them all, which the saved
 * input (the files themselves) allows.
 */

import { assembleTextbook } from '$lib/db';
import type { LearnerProfile } from '$lib/db/generated/index';
import { openPages, transcribePage } from '$lib/textbook';
import type { TextbookDraft, TextbookPage } from '$lib/textbook';
import type { TaskKindDef } from '../types';

/** Pages read at once: the same three a page's translations use. */
const CONCURRENCY = 3;

export interface TextbookImportInput {
	profile: LearnerProfile;
	/** One PDF, or the page images in order. Kept for Retry, like any input. */
	files: File[];
	/** Pages to read, from 1, inclusive. */
	from: number;
	to: number;
	/** The vision model; blank is the learner's own. */
	model?: string;
	/** What the tray calls it: the file's name. */
	name: string;
}

export interface TextbookImportResult {
	draft: TextbookDraft;
	name: string;
	pages: number;
}

function aborted(signal: AbortSignal): boolean {
	return signal.aborted;
}

export const textbookImportTask = {
	// One at a time: they spend the same key's rate limit, and a learner
	// reviews one lesson at a time anyway.
	serial: true,

	title(input) {
		const pages = input.to > input.from ? `pp. ${input.from}–${input.to}` : `p. ${input.from}`;
		return `Reading ${input.name}, ${pages}`;
	},

	async run(input, ctx) {
		ctx.step('open', 'Opening the pages');
		const source = await openPages(input.files);
		const wanted: number[] = [];
		for (let n = input.from; n <= Math.min(input.to, source.count); n++) wanted.push(n);
		if (wanted.length === 0) {
			source.close();
			throw new Error('Those pages are not in the file.');
		}

		ctx.step('read', `Reading ${wanted.length} page${wanted.length === 1 ? '' : 's'}`);
		const pages: TextbookPage[] = new Array(wanted.length);
		let next = 0;
		let done = 0;
		ctx.progress(0, wanted.length, 'pages');
		try {
			await Promise.all(
				Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
					while (next < wanted.length && !aborted(ctx.signal)) {
						const at = next++;
						const image = await source.render(wanted[at]);
						pages[at] = await transcribePage(
							{ profile: input.profile, image, page: at + 1 },
							{ signal: ctx.signal, model: input.model }
						);
						ctx.progress(++done, wanted.length, 'pages');
					}
				})
			);
		} finally {
			source.close();
		}
		ctx.signal.throwIfAborted();

		ctx.step('assemble', 'Putting the lesson together');
		const draft = await assembleTextbook(pages);
		if (draft.segments.length === 0) {
			throw new Error('There is nothing in the target language on those pages.');
		}
		return { draft, name: input.name, pages: wanted.length };
	},

	summary(result) {
		const lines = result.draft.segments.length;
		return `${lines} line${lines === 1 ? '' : 's'} ready to review`;
	}
} satisfies TaskKindDef<TextbookImportInput, TextbookImportResult>;
