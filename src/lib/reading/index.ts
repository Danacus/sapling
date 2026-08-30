/**
 * Public surface of reading mode.
 *
 * Two doors in — {@link generateReadingText} for a text written from the
 * learner's vocabulary, {@link annotateReadingText} for one they pasted — and
 * both come out as a {@link ReadingTextDraft} the page mints an id for and
 * stores. {@link lookUpWord} is the third paid call and the only one that runs
 * *while* reading: one word the glossary missed, explained in the sentence it
 * stands in, which the page merges into the glossary for the rest of that open.
 * Everything else is local: `parseSubtitles` turns a `.srt`/`.vtt` file into
 * cues, `splitSentences` cuts an import before it is ever sent, `chunkSentences`
 * decides how many calls it takes, `paginate` decides where the pages break,
 * and `tokenizeByTerms` and
 * `annotateSentence` decide what the reader sees — none of which costs a token
 * or a round trip.
 *
 * Stateless, like `$lib/conversation`: **nothing here imports `$lib/db`.** The
 * caller passes the vocabulary in and persists what comes out, which is what
 * keeps the whole module testable in node and what keeps every write to the
 * learner's collection going through the repositories that capture sync events.
 */

import { isMockMode } from '$lib/llm';
import type { TokenUsage } from '$lib/llm';
import type { GlossEntry } from '$lib/types';
import { mockAnnotatedText, mockGeneratedText, mockLookedUpWord } from './mock';
import { MAX_IMPORT_CHARS, requestAnnotatedText, resolveTitle } from './annotate-call';
import type { AnnotateTextArgs } from './annotate-call';
import { chunkSentences } from './chunks';
import { wordKey } from './tokenize';
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

/**
 * How many calls annotating `sentences` will take.
 *
 * The page shows it before spending anything: an import is the one action in
 * the app whose cost is not obvious from looking at it, and "about 7 calls" is
 * the difference between a learner choosing to paste a whole article and being
 * surprised by one.
 */
export function importCallCount(sentences: readonly string[]): number {
	return chunkSentences(sentences, MAX_IMPORT_CHARS).length;
}

/**
 * One pasted text annotated, mock-aware in the same way — and chunked, because
 * a text the learner found is as long as it happens to be.
 *
 * The sentences are packed into calls of at most `MAX_IMPORT_CHARS`
 * (`./chunks`) and the calls are made **in order and one at a time**: a
 * provider's rate limit is the ordinary failure here, and a fan-out would
 * either trip it or, worse, half-succeed and leave the learner paying for six
 * calls to get one error. Sequential also means a failure stops at the first
 * chunk instead of after all of them.
 *
 * Merging is per chunk, which makes the alignment rule strictly kinder than it
 * was: a model that miscounts one chunk now costs that chunk's readings and
 * translations rather than the whole text's. Glossaries concatenate and dedupe
 * by `wordKey` with the first entry winning — the earliest sense is the one the
 * learner meets first, and the reader matches on that key and nothing else, so
 * a second entry for the same word would simply be unreachable.
 *
 * The learner's title goes only to the first chunk. Asked ten times, a model
 * names each chunk after its own contents and the text ends up titled after its
 * middle; asked once, the title is about the opening, which is how texts are
 * named.
 */
export async function annotateReadingText(
	args: AnnotateTextArgs,
	opts: ReadingOptions = {}
): Promise<ReadingTextDraft> {
	const { title, ...rest } = args;
	const chunks = chunkSentences(args.sentences, MAX_IMPORT_CHARS);
	const total = chunks.length;

	// Nothing to annotate: still a draft, so the caller has one shape to handle.
	if (total === 0) {
		return {
			title: resolveTitle(args, { sentences: [], glossary: [] }),
			sentences: [],
			glossary: []
		};
	}

	const sentences: ReadingTextDraft['sentences'] = [];
	const glossary: GlossEntry[] = [];
	const seen = new Set<string>();
	let resolved = '';
	let usage: TokenUsage | undefined;

	for (let i = 0; i < total; i++) {
		const chunkArgs: AnnotateTextArgs =
			i === 0 && title
				? { ...rest, title, sentences: chunks[i] }
				: { ...rest, sentences: chunks[i] };

		const draft = isMockMode()
			? await mockAnnotatedText(chunkArgs)
			: await requestAnnotatedText(chunkArgs, opts);

		if (!resolved) resolved = draft.title;
		sentences.push(...draft.sentences);
		for (const entry of draft.glossary) {
			const key = wordKey(entry.term);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			glossary.push(entry);
		}
		if (draft.usage) {
			usage = {
				promptTokens: (usage?.promptTokens ?? 0) + draft.usage.promptTokens,
				completionTokens: (usage?.completionTokens ?? 0) + draft.usage.completionTokens
			};
		}

		opts.onProgress?.(i + 1, total);
	}

	return { title: resolved, sentences, glossary, ...(usage ? { usage } : {}) };
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
	MAX_IMPORT_TOTAL_CHARS,
	annotatedSentences,
	buildAnnotatePrompt,
	parseAnnotatedText,
	requestAnnotatedText,
	resolveTitle
} from './annotate-call';
export type { AnnotateTextArgs, AnnotatedText, SentenceAnnotation } from './annotate-call';

export { annotateSentence, showSentenceReading, termsFor } from './annotate';
export type { AnnotateContext, ReadingWord, TokenizeFn, WordStatus } from './annotate';

export { chunkSentences } from './chunks';

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

export { hasSentenceEnd, splitSentences } from './sentences';

export { cuesToSentences, detectSubtitleFormat, parseSubtitles } from './subtitles';
export type { Cue, SubtitleFormat, TimedSentence } from './subtitles';

export { tokenizeByTerms, wordKey } from './tokenize';

export type { GlossEntry, ReadingSentence, ReadingText } from '$lib/types';
