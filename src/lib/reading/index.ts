/**
 * Public surface of reading mode.
 *
 * One paid door in — {@link generateReadingText}, a text written from the
 * learner's vocabulary, which comes out as a {@link ReadingTextDraft} the task
 * mints an id for and stores. An imported text needs no call at all: the Rust
 * core's `importSource`, which the *caller* reaches through `$lib/db`, cuts it
 * into the segments it is stored as, and this module never sees the import.
 * {@link lookUpWord} and {@link translateLine} are the two paid calls that run
 * *while* reading: one word, explained in the sentence it stands in, and one
 * segment in the learner's own language — both kept by the page for the rest of
 * that open and never stored. The three calls — prompts, parsing and mock
 * included — are `crates/sapling-llm`'s. Everything else is local: `paginate`
 * decides where the pages break (and `sentenceAt` which sentence a word travels
 * with), and `tokenizeByTerms` and `annotateSentence` decide what the reader
 * sees — none of which costs a token or a round trip.
 *
 * Stateless, like `$lib/conversation`: **nothing here imports `$lib/db`.** The
 * caller passes the vocabulary in and persists what comes out, which is what
 * keeps the whole module testable in node and what keeps every write to the
 * learner's collection going through the repositories that capture sync events.
 */

import { callLlm } from '$lib/llm';
import type {
	CallOptions,
	GenerateTextArgs,
	GlossEntry,
	LookupWordArgs,
	ReadingTextDraft,
	TranslateLineArgs
} from '$lib/llm';

/** One text written from the learner's own words. */
export function generateReadingText(
	args: GenerateTextArgs,
	opts: CallOptions = {}
): Promise<ReadingTextDraft> {
	return callLlm('generateReadingText', args, opts);
}

/** One word explained where it stands. Paid, so only a button fires it. */
export function lookUpWord(args: LookupWordArgs, opts: CallOptions = {}): Promise<GlossEntry> {
	return callLlm('lookUpWord', args, opts);
}

/** One segment in the learner's native language. Paid, so only a button fires it. */
export function translateLine(args: TranslateLineArgs, opts: CallOptions = {}): Promise<string> {
	return callLlm('translateLine', args, opts);
}

export { MAX_FOCUS_WORDS, MAX_TOPIC_CHARS } from '$lib/llm';
export type {
	FocusWord,
	GenerateTextArgs,
	GlossEntry,
	LookupWordArgs,
	ReadingTextDraft,
	TranslateLineArgs
} from '$lib/llm';

export { annotateSentence, lookedUpGloss, termsFor } from './annotate';
export type { AnnotateContext, ReadingWord, TokenizeFn, WordStatus } from './annotate';

export {
	PAGE_WORDS,
	countWords,
	paginate,
	pieceOffset,
	piecesOfSegment,
	sentenceAt
} from './pages';
export type { PageRange, Pagination, Piece } from './pages';

export { tokenizeByTerms, wordKey } from './tokenize';

export type { ReadingText, Segment } from '$lib/types';
