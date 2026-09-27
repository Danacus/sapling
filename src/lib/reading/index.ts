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
 * that open and never stored. Everything else is local: `paginate` decides where
 * the pages break (and `sentenceAt` which sentence a word travels with), and
 * `tokenizeByTerms` and `annotateSentence` decide what the reader sees — none of
 * which costs a token or a round trip.
 *
 * Stateless, like `$lib/conversation`: **nothing here imports `$lib/db`.** The
 * caller passes the vocabulary in and persists what comes out, which is what
 * keeps the whole module testable in node and what keeps every write to the
 * learner's collection going through the repositories that capture sync events.
 */

import { isMockMode } from '$lib/llm';
import { mockGeneratedText, mockLineTranslation, mockLookedUpWord } from './mock';
import { requestGeneratedText } from './generate';
import type { GenerateTextArgs, ReadingOptions } from './generate';
import { requestLookedUpWord } from './lookup-call';
import type { LookupWordArgs } from './lookup-call';
import type { GlossEntry, ReadingTextDraft } from './schemas';
import { requestLineTranslation } from './translate-call';
import type { TranslateLineArgs } from './translate-call';

/**
 * One text written from the learner's own words: the real call when a key is
 * configured, the deterministic mock otherwise — the same dispatch `getBatch`
 * and `startConversation` make.
 */
export async function generateReadingText(
	args: GenerateTextArgs,
	opts: ReadingOptions = {}
): Promise<ReadingTextDraft> {
	if (isMockMode()) return mockGeneratedText(args);
	return requestGeneratedText(args, opts);
}

/**
 * One word explained where it stands.
 *
 * Paid, and the only call in the module that happens mid-read — so the caller
 * fires it from a button and never from a tap. What comes back is an ordinary
 * {@link GlossEntry}; the page decides what to do with it.
 */
export async function lookUpWord(
	args: LookupWordArgs,
	opts: ReadingOptions = {}
): Promise<GlossEntry> {
	if (isMockMode()) return mockLookedUpWord(args);
	return requestLookedUpWord(args, opts);
}

/**
 * One segment in the learner's native language.
 *
 * Paid and mid-read like {@link lookUpWord}, so a button fires it and the page
 * keeps the answer by segment index for the rest of that open.
 */
export async function translateLine(
	args: TranslateLineArgs,
	opts: ReadingOptions = {}
): Promise<string> {
	if (isMockMode()) return mockLineTranslation(args);
	return requestLineTranslation(args, opts);
}

export { annotateSentence, lookedUpGloss, termsFor } from './annotate';
export type { AnnotateContext, ReadingWord, TokenizeFn, WordStatus } from './annotate';

export {
	MAX_ABOUT_CHARS,
	MAX_FOCUS_WORDS,
	MAX_TOPIC_CHARS,
	MAX_VOCABULARY_TERMS,
	SENTENCES_BY_LEVEL,
	buildGeneratePrompt,
	parseGeneratedText,
	requestGeneratedText,
	sentenceCountFor
} from './generate';
export type { FocusWord, GenerateTextArgs, ReadingOptions } from './generate';

export {
	buildLookupPrompt,
	parseLookedUpWord,
	requestLookedUpWord,
	toGlossEntry
} from './lookup-call';
export type { LookupWordArgs } from './lookup-call';

export { mockGeneratedText, mockLineTranslation, mockLookedUpWord } from './mock';

export {
	PAGE_WORDS,
	countWords,
	paginate,
	pieceOffset,
	piecesOfSegment,
	sentenceAt
} from './pages';
export type { PageRange, Pagination, Piece } from './pages';

export {
	GENERATED_TEXT_SCHEMA_NAME,
	LINE_TRANSLATION_SCHEMA_NAME,
	LOOKED_UP_WORD_SCHEMA_NAME,
	generatedTextJsonSchema,
	generatedTextSchema,
	glossEntrySchema,
	lineTranslationJsonSchema,
	lineTranslationSchema,
	lookedUpWordJsonSchema
} from './schemas';
export type { GlossEntry, ReadingTextDraft } from './schemas';

export {
	buildTranslatePrompt,
	parseLineTranslation,
	requestLineTranslation
} from './translate-call';
export type { TranslateLineArgs } from './translate-call';

export { tokenizeByTerms, wordKey } from './tokenize';

export type { ReadingText, Segment } from '$lib/types';
