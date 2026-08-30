/**
 * Public surface of reading mode.
 *
 * Two doors in — {@link generateReadingText} for a text written from the
 * learner's vocabulary, {@link annotateReadingText} for one they pasted — and
 * both come out as a {@link ReadingTextDraft} the page mints an id for and
 * stores. {@link lookUpWord} is the third paid call and the only one that runs
 * *while* reading: one word the glossary missed, explained in the sentence it
 * stands in, which the page merges into the glossary for the rest of that open.
 * Everything else is local: `splitSentences` cuts an import before it is ever
 * sent, `paginate` decides where the pages break, and `tokenizeByTerms` and
 * `annotateSentence` decide what the reader sees — none of which costs a token
 * or a round trip.
 *
 * Stateless, like `$lib/conversation`: **nothing here imports `$lib/db`.** The
 * caller passes the vocabulary in and persists what comes out, which is what
 * keeps the whole module testable in node and what keeps every write to the
 * learner's collection going through the repositories that capture sync events.
 */

import { isMockMode } from '$lib/llm';
import type { GlossEntry } from '$lib/types';
import { mockAnnotatedText, mockGeneratedText, mockLookedUpWord } from './mock';
import { requestAnnotatedText } from './annotate-call';
import type { AnnotateTextArgs } from './annotate-call';
import { requestGeneratedText } from './generate';
import type { GenerateTextArgs, ReadingOptions } from './generate';
import { requestLookedUpWord } from './lookup-call';
import type { LookupWordArgs } from './lookup-call';
import type { ReadingTextDraft } from './schemas';

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

/** One pasted text annotated, mock-aware in the same way. */
export async function annotateReadingText(
	args: AnnotateTextArgs,
	opts: ReadingOptions = {}
): Promise<ReadingTextDraft> {
	if (isMockMode()) return mockAnnotatedText(args);
	return requestAnnotatedText(args, opts);
}

/**
 * One word explained where it stands, for a word the glossary missed.
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

export {
	MAX_IMPORT_CHARS,
	annotatedSentences,
	buildAnnotatePrompt,
	parseAnnotatedText,
	requestAnnotatedText,
	resolveTitle
} from './annotate-call';
export type { AnnotateTextArgs, AnnotatedText, SentenceAnnotation } from './annotate-call';

export { annotateSentence, showSentenceReading, termsFor } from './annotate';
export type { AnnotateContext, ReadingWord, TokenizeFn, WordStatus } from './annotate';

export {
	GLOSSARY_RULES,
	MAX_ABOUT_CHARS,
	MAX_FOCUS_WORDS,
	MAX_TOPIC_CHARS,
	MAX_VOCABULARY_TERMS,
	SENTENCES_BY_LEVEL,
	buildGeneratePrompt,
	parseGeneratedText,
	requestGeneratedText,
	sentenceCountFor,
	toGlossEntry,
	toGlossary
} from './generate';
export type { FocusWord, GenerateTextArgs, ReadingOptions } from './generate';

export { buildLookupPrompt, parseLookedUpWord, requestLookedUpWord } from './lookup-call';
export type { LookupWordArgs } from './lookup-call';

export {
	MOCK_GLOSSARY_WORDS,
	mockAnnotatedText,
	mockGeneratedText,
	mockLookedUpWord
} from './mock';

export { PAGE_WORDS, countWords, paginate } from './pages';
export type { PageRange } from './pages';

export {
	ANNOTATED_TEXT_SCHEMA_NAME,
	GENERATED_TEXT_SCHEMA_NAME,
	LOOKED_UP_WORD_SCHEMA_NAME,
	annotatedSentenceSchema,
	annotatedTextJsonSchema,
	annotatedTextSchema,
	generatedSentenceSchema,
	generatedTextJsonSchema,
	generatedTextSchema,
	glossEntrySchema,
	lookedUpWordJsonSchema
} from './schemas';
export type { ReadingTextDraft } from './schemas';

export { splitSentences } from './sentences';

export { tokenizeByTerms, wordKey } from './tokenize';

export type { GlossEntry, ReadingSentence, ReadingText } from '$lib/types';
