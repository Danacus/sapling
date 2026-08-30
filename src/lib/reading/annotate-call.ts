/**
 * The annotate call: the other door into reading mode, for a text the learner
 * found rather than one the model wrote.
 *
 * An article, a song, a video transcript — anything they actually want to read.
 * The app cannot write that text and must not rewrite it, so this call is the
 * inverse of `./generate`: the sentences travel *to* the model, numbered
 * (`./sentences` cut them locally), and only annotations come back. What is on
 * screen is then exactly what was pasted, character for character, which is the
 * whole reason a learner pastes something instead of asking for a text.
 *
 * The alignment is the fragile part, and it is handled all-or-nothing. A model
 * that merges two sentences or skips a line returns an array of the wrong
 * length, and there is no honest way to guess which annotation belongs to which
 * sentence — a translation under the wrong line is worse than no translation.
 * So a mismatch drops every reading and translation and keeps the glossary,
 * which is index-free and still worth what it cost: the reader gets its word
 * cards and its segmentation, and only the sentence-level annotations are lost.
 *
 * Named apart from `./annotate` on purpose. That module is the render-time
 * annotation of words against the learner's vocabulary and runs on every text
 * every time it is opened; this one is a paid LLM call that happens once.
 */

import { LlmError, chatCompletion, stripFences } from '$lib/llm';
import type { BatchProfile, ChatMessage } from '$lib/llm';
import type { GlossEntry, ReadingSentence } from '$lib/types';
import { GLOSSARY_RULES, MAX_VOCABULARY_TERMS, toGlossary } from './generate';
import type { ReadingOptions } from './generate';
import {
	ANNOTATED_TEXT_SCHEMA_NAME,
	annotatedTextJsonSchema,
	annotatedTextSchema
} from './schemas';
import type { ReadingTextDraft } from './schemas';

export interface AnnotateTextArgs {
	profile: BatchProfile;
	/** The learner's terms, so the glossary can skip what they already have. */
	vocabulary: string[];
	/** Already split by the page (`./sentences`), and sent verbatim. */
	sentences: string[];
	/** The learner's own title, when they typed one. */
	title?: string;
}

/**
 * How much text **one call** may carry, in characters.
 *
 * Not a technical limit — it is what one call can annotate well. Past a few
 * thousand characters the model starts thinning out the later translations and
 * the glossary stops covering the tail, and the failure is invisible: a text
 * that looks annotated but goes bare halfway down. A longer import is cut into
 * chunks of this size by `./chunks` and annotated a chunk at a time, which is
 * what makes an article or a subtitle file importable at all — see
 * {@link MAX_IMPORT_TOTAL_CHARS} for the ceiling on the whole import.
 */
export const MAX_IMPORT_CHARS = 4000;

/**
 * How much text one import may carry in total, in characters.
 *
 * The chunking removed the quality ceiling, so what is left is a cost and
 * patience ceiling: 40 000 characters is ten sequential calls, a minute or two
 * of waiting, and about a long magazine article or an hour of subtitles — past
 * that a learner is importing a book, and a book is a different feature. The
 * page enforces it, because it is the page that can say so before the money is
 * spent.
 */
export const MAX_IMPORT_TOTAL_CHARS = 40000;

/** When neither the learner nor the model named the text, its first words do. */
const FALLBACK_TITLE_CHARS = 40;

/**
 * Static, like the write prompt's, and carrying one rule the other does not
 * need: **one entry per numbered sentence, in order**. Everything downstream of
 * this call is index alignment, and the model is told so plainly rather than
 * left to infer it from the shape.
 *
 * The glossary rules come from `./generate` verbatim: both calls fill the same
 * field for the same reader, and the exact-form rule matters more here than
 * anywhere — this text is somebody else's prose, so the inflected forms are
 * whatever they happen to be.
 */
const SYSTEM_PROMPT = [
	'You annotate a text a language learner has pasted in, so they can read it. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"title","sentences":[{"reading","translation"}],"glossary":[{"term","reading","meaning"}]}',
	'The user message numbers the sentences of the text. "sentences" holds exactly one entry per numbered sentence, in the same order. Never merge two, never split one, never reorder or skip one: entry 1 annotates sentence 1 and nothing else. An array of any other length is unusable.',
	'Never return the sentences themselves. The app already has them and shows them exactly as they were pasted.',
	'"reading" is the Latin-script reading of that sentence: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. It is ALWAYS null when the target language is written in the Latin script.',
	'"translation" is that sentence in the NATIVE language — a natural translation, not a word-for-word gloss.',
	'"title" is short — a few words — and in the TARGET language. When the user message already carries a "title", repeat it unchanged.',
	'Rules:',
	...GLOSSARY_RULES,
	'- Annotate what is there. A sentence fragment, a heading or a stray line still gets its entry; translate it as it stands rather than repairing it.'
].join('\n');

/** Builds the two messages for one annotate call. */
export function buildAnnotatePrompt(args: AnnotateTextArgs): ChatMessage[] {
	const { profile } = args;
	const title = args.title?.trim();

	const payload: Record<string, unknown> = {
		native: profile.nativeLanguage,
		target: profile.targetLanguage,
		level: profile.level,
		...(title ? { title } : {}),
		sentenceCount: args.sentences.length,
		// Numbered explicitly rather than left to array position: the one thing
		// this call has to get right is which annotation belongs to which line.
		sentences: args.sentences.map((text, i) => ({ n: i + 1, text })),
		vocabulary: args.vocabulary
			.map((term) => term.trim())
			.filter(Boolean)
			.slice(0, MAX_VOCABULARY_TERMS)
	};

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/** One sentence's annotations, `null`/blank normalized away. */
export interface SentenceAnnotation {
	reading?: string;
	translation?: string;
}

/** One parsed annotate completion, before it is married to the local sentences. */
export interface AnnotatedText {
	/** The model's suggestion; the learner's own title outranks it. */
	title?: string;
	/**
	 * One entry per sentence sent, index-aligned — or **empty**, when the model's
	 * array did not line up and every annotation had to be dropped together.
	 */
	sentences: SentenceAnnotation[];
	/** Kept whatever happens to the alignment: it is keyed by term, not by index. */
	glossary: GlossEntry[];
}

function trimmed(value: string | null | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

/**
 * Reads one annotate completion against the number of sentences that were sent.
 *
 * Throws only on an unusable envelope. A length mismatch is not one: the
 * glossary survives it, so the text is still worth storing.
 */
export function parseAnnotatedText(raw: string, sentenceCount: number): AnnotatedText {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not annotate the text. Try again.', {
			cause
		});
	}

	const parsed = annotatedTextSchema.safeParse(json);
	if (!parsed.success) {
		throw new LlmError('bad-response', 'The model returned annotations in an unexpected shape.');
	}

	const aligned = parsed.data.sentences.length === sentenceCount;
	const title = trimmed(parsed.data.title);

	return {
		...(title ? { title } : {}),
		sentences: aligned
			? parsed.data.sentences.map((entry) => {
					const reading = trimmed(entry.reading);
					const translation = trimmed(entry.translation);
					return {
						...(reading ? { reading } : {}),
						...(translation ? { translation } : {})
					};
				})
			: [],
		glossary: toGlossary(parsed.data.glossary)
	};
}

/**
 * The learner's sentences wearing the model's annotations.
 *
 * The text always comes from `sentences` — the local split — so an empty
 * `parsed.sentences` (a dropped alignment) yields the pasted text with no
 * readings and no translations rather than nothing at all.
 */
export function annotatedSentences(
	sentences: readonly string[],
	parsed: AnnotatedText
): ReadingSentence[] {
	return sentences.map((text, i) => {
		const annotation = parsed.sentences[i];
		return {
			text,
			...(annotation?.reading ? { reading: annotation.reading } : {}),
			...(annotation?.translation ? { translation: annotation.translation } : {})
		};
	});
}

/** The learner's title, else the model's, else the opening words of the text. */
export function resolveTitle(args: AnnotateTextArgs, parsed: AnnotatedText): string {
	const own = args.title?.trim();
	if (own) return own;
	if (parsed.title) return parsed.title;
	const opening = args.sentences[0]?.trim() ?? '';
	return opening.length > FALLBACK_TITLE_CHARS
		? `${opening.slice(0, FALLBACK_TITLE_CHARS).trimEnd()}…`
		: opening;
}

/** The real annotate call; {@link annotateReadingText} in `./index` picks it or the mock. */
export async function requestAnnotatedText(
	args: AnnotateTextArgs,
	opts: ReadingOptions = {}
): Promise<ReadingTextDraft> {
	const completion = await chatCompletion({
		messages: buildAnnotatePrompt(args),
		responseFormat: { schema: annotatedTextJsonSchema(), name: ANNOTATED_TEXT_SCHEMA_NAME },
		// No `maxTokens` — see `requestGeneratedText`.
		temperature: 0.3,
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn
	});

	const parsed = parseAnnotatedText(completion.content, args.sentences.length);
	return {
		title: resolveTitle(args, parsed),
		sentences: annotatedSentences(args.sentences, parsed),
		glossary: parsed.glossary,
		usage: completion.usage
	};
}
