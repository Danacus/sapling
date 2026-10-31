/**
 * Textbooks: a book read page by page by a vision model into its chapters, and
 * the views that show it as the book prints it — chapters, then sections:
 * dialogues with their speakers, standalone sentences, vocabulary lists.
 *
 * The call and the clean-up are Rust (`crates/sapling-llm`'s `textbook.rs`
 * reads a page; `crates/sapling-import`'s `textbook.rs` tidies it — pinyin out
 * of a Chinese page included — and splits the book into chapters, behind the
 * `assembleTextbook` backend method); a stored book is `addTextbook`'s. This
 * module forwards the call and holds what the pages decide that is not
 * markup: page ranges, chapter names, a chapter's one-line summary, and what
 * a vocabulary entry files as. `render.ts` turns a PDF or images into page
 * pictures; the `textbook-import` task runs the reading.
 *
 * **No reading is ever stored or asked for.** A word's reading on screen is
 * `$lib/romanize`'s, taken from where the word stands in the chapter's lines.
 */

import type {
	Chapter,
	NewWord,
	Section,
	TextbookPage,
	TextbookWord,
	TranscribePageArgs
} from '$lib/db/generated/index';
import { callLlm } from '$lib/llm';
import type { CallOptions } from '$lib/llm';

export type { Chapter, Section, TextbookPage, TextbookWord };
export type { Textbook, TextbookSummary, TextbookLine } from '$lib/db/generated/index';
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

/** At most this many pages per import: a whole textbook, not a library. */
export const MAX_PAGES = 400;

/**
 * What a chapter is called on screen: "3 · 你叫什么名字", the label alone, the
 * title alone, or — for pages before the first lesson — "Introduction".
 */
export function chapterName(chapter: Pick<Chapter, 'label' | 'title'>): string {
	const label = chapter.label?.trim();
	const title = chapter.title?.trim();
	if (label && title) return title.includes(label) ? title : `${label} · ${title}`;
	return title || label || 'Introduction';
}

/** "pp. 14–21", "p. 14", or nothing when the pages showed no numbers. */
export function pagesOf(chapter: Pick<Chapter, 'firstPage' | 'lastPage'>): string {
	const first = chapter.firstPage;
	const last = chapter.lastPage;
	if (!first) return '';
	return last && last !== first ? `pp. ${first}–${last}` : `p. ${first}`;
}

/** "2 dialogues · 6 sentences · 9 words": what a chapter holds, in a line. */
export function chapterSummary(chapter: Pick<Chapter, 'sections'>): string {
	let dialogues = 0;
	let sentences = 0;
	let words = 0;
	for (const section of chapter.sections) {
		if (section.kind === 'dialogue') dialogues += 1;
		else if (section.kind === 'sentences') sentences += section.lines.length;
		else words += section.words.length;
	}
	const parts: string[] = [];
	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	if (dialogues) parts.push(count(dialogues, 'dialogue', 'dialogues'));
	if (sentences) parts.push(count(sentences, 'sentence', 'sentences'));
	if (words) parts.push(count(words, 'word', 'words'));
	return parts.join(' · ');
}

/** Every vocabulary term a chapter lists, once each, in order. */
export function chapterTerms(chapter: Pick<Chapter, 'sections'>): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const section of chapter.sections) {
		for (const word of section.words) {
			const term = word.term.trim();
			if (term && !seen.has(term)) {
				seen.add(term);
				terms.push(term);
			}
		}
	}
	return terms;
}

/**
 * What `add_words` files for a book's word: the term, the meaning the learner
 * sees (the book's, or what they typed), the frontend's reading of it where
 * there is one, and the book's notes. No meaning, nothing to file.
 */
export function toNewWord(
	word: Pick<TextbookWord, 'term' | 'notes'>,
	meaning: string,
	reading?: string | null
): NewWord | undefined {
	const term = word.term.trim();
	const gloss = meaning.trim();
	if (!term || !gloss) return undefined;
	return {
		term,
		meaning: gloss,
		...(reading?.trim() ? { romanization: reading.trim() } : {}),
		...(word.notes?.trim() ? { notes: word.notes.trim() } : {})
	};
}
