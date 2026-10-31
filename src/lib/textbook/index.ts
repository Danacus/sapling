/**
 * Textbook import: a lesson's scanned pages read by a vision model into the
 * lines of a text the learner reviews before it is kept.
 *
 * The call and the clean-up are Rust (`crates/sapling-llm`'s `textbook.rs`
 * reads a page; `crates/sapling-import`'s `textbook.rs` tidies it — pinyin
 * out of a Chinese line included — and assembles the lesson, behind the
 * `assembleTextbook` backend method). This module forwards the call and holds
 * the form's page-range arithmetic; `render.ts` turns a PDF or images into
 * page pictures; the `textbook-import` task runs the job. Words are not this
 * module's: they are added from the stored text afterwards, like any text's.
 */

import type { TextbookPage, TranscribePageArgs } from '$lib/db/generated/index';
import { callLlm } from '$lib/llm';
import type { CallOptions } from '$lib/llm';

export type { TextbookPage };
export type { TextbookDraft } from '$lib/db/generated/index';
export { isPdf, openPages } from './render';
export type { PageSource } from './render';

/** One page, transcribed and tidied. Pass `model` in `opts`: the page needs one that sees images. */
export function transcribePage(
	args: TranscribePageArgs,
	opts: CallOptions = {}
): Promise<TextbookPage> {
	return callLlm('transcribePage', args, opts);
}

/**
 * A page range typed as two numbers, clamped to the document: `from` at least
 * 1, `to` at most `count`, and never before `from`. `undefined` when there is
 * nothing to read.
 */
export function pageRange(
	from: number,
	to: number,
	count: number
): { from: number; to: number } | undefined {
	if (!Number.isFinite(from) || !Number.isFinite(to) || count < 1) return undefined;
	const start = Math.min(count, Math.max(1, Math.floor(from)));
	const end = Math.min(count, Math.max(start, Math.floor(to)));
	return { from: start, to: end };
}

/** At most this many pages per import: one lesson, not a book. */
export const MAX_PAGES = 30;
