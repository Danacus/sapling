/**
 * Textbook import: a lesson's scanned pages read by a vision model, assembled
 * into a text and a word list the learner reviews before anything is kept.
 *
 * The calls and the clean-up are Rust (`crates/sapling-llm`'s `textbook.rs`
 * reads a page and glosses words; `crates/sapling-import`'s `textbook.rs`
 * tidies and assembles, behind the `assembleTextbook` backend method). This
 * module forwards the two calls, and holds the review's pure decisions: which
 * words start ticked and what `add_words` is handed. `render.ts` turns a PDF
 * or images into page pictures; the `textbook-import` task runs the whole job.
 */

import type {
	GlossWordsArgs,
	GlossedWord,
	NewWord,
	TextbookPage,
	TextbookWord,
	TranscribePageArgs
} from '$lib/db/generated/index';
import { callLlm, MAX_GLOSS_WORDS } from '$lib/llm';
import type { CallOptions } from '$lib/llm';
import { termKey } from '$lib/text';

export type { GlossedWord, TextbookPage, TextbookWord };
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

/** Meanings for the words given, at most `MAX_GLOSS_WORDS` a call. */
export function glossWords(args: GlossWordsArgs, opts: CallOptions = {}): Promise<GlossedWord[]> {
	return callLlm('glossWords', args, opts);
}

/** `words` cut into the calls `glossWords` takes. */
export function glossBatches<T>(words: readonly T[]): T[][] {
	const batches: T[][] = [];
	for (let at = 0; at < words.length; at += MAX_GLOSS_WORDS) {
		batches.push(words.slice(at, at + MAX_GLOSS_WORDS));
	}
	return batches;
}

/** Each word with the meaning (and reading, where it had none) a gloss found for it. */
export function withGlosses(
	words: readonly TextbookWord[],
	glosses: readonly GlossedWord[]
): TextbookWord[] {
	const found = new Map(glosses.map((gloss) => [termKey(gloss.term), gloss]));
	return words.map((word) => {
		const gloss = word.meaning ? undefined : found.get(termKey(word.term));
		if (!gloss) return word;
		return {
			...word,
			meaning: gloss.meaning,
			...(word.reading || !gloss.reading ? {} : { reading: gloss.reading })
		};
	});
}

/**
 * Whether a listed word starts ticked: the book chose it, so yes — unless it
 * is a name (a learner rarely wants a card for 李月), or the learner already
 * has a word spelled that way. `known` is `termKey`s.
 */
export function startsPicked(word: TextbookWord, known: ReadonlySet<string>): boolean {
	return !word.proper && !known.has(termKey(word.term));
}

/**
 * What `add_words` files for a word: the term, the meaning the learner sees in
 * the row (which they may have edited), the book's reading as the
 * romanization, and its notes. A word with no meaning cannot be filed, so it
 * is left out; the form does not offer it.
 */
export function toNewWord(word: TextbookWord, meaning: string): NewWord | undefined {
	const term = word.term.trim();
	const gloss = meaning.trim();
	if (!term || !gloss) return undefined;
	return {
		term,
		meaning: gloss,
		...(word.reading?.trim() ? { romanization: word.reading.trim() } : {}),
		...(word.notes?.trim() ? { notes: word.notes.trim() } : {})
	};
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
