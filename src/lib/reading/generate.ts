/**
 * The write call: one request that turns the learner's vocabulary into a text
 * worth reading.
 *
 * The mirror image of `$lib/llm/generate`. A lesson batch is written *about* a
 * handful of words and drills them one question at a time; a reading text is
 * written *out of* the whole collection and asks nothing at all. That is the
 * point of the mode — the words the learner owns finally appear as a piece of
 * language instead of as twenty prompts — so the prompt's job is to keep the
 * model building from the vocabulary while letting a few strangers in, because
 * a text with no unknown words is a flashcard with paragraph breaks.
 *
 * Stateless, like everything in this module: data in, data out, and no import
 * of `$lib/db`. The caller supplies the vocabulary and persists the result.
 *
 * The system prompt is static — no profile, no counts, no word lists — so it
 * caches across every learner and every call on providers that support prompt
 * caching. Everything learner-specific rides in the user message as compact
 * JSON, exactly as the batch prompt does.
 */

import { LlmError, MAX_ABOUT_CHARS, chatCompletion, stripFences } from '$lib/llm';
import type { BatchProfile, ChatMessage, FetchLike } from '$lib/llm';
import { cardKey } from '$lib/text';
import type { GlossEntry, Level, ReadingSentence } from '$lib/types';
import {
	GENERATED_TEXT_SCHEMA_NAME,
	generatedTextJsonSchema,
	generatedTextSchema
} from './schemas';
import type { ReadingTextDraft } from './schemas';

/** One word the text must actually use: the word, and what it means. */
export interface FocusWord {
	term: string;
	meaning: string;
}

export interface GenerateTextArgs {
	profile: BatchProfile;
	/**
	 * Every term the learner has, and the material the text is built from. Terms
	 * only — reading mode never cites an id, so the ids stay on this side and the
	 * prompt stays cheap (the same bargain `knownItems` strikes in the batch
	 * prompt).
	 */
	vocabulary: string[];
	/**
	 * The words this text is *for*: what the schedule owes, most overdue first.
	 * Each must appear at least once, so a text is a genuine review and not just
	 * pleasant reading.
	 */
	focus: FocusWord[];
	/** The learner's free-form topic. Blank means "you choose". */
	topic?: string;
}

/** Test seams and per-call overrides. Production passes none of them. */
export interface ReadingOptions {
	signal?: AbortSignal;
	fetchFn?: FetchLike;
	apiKey?: string;
	model?: string;
	/**
	 * How far a chunked import has got, called once per chunk as it lands.
	 *
	 * Only `annotateReadingText` ever calls it — it is the one entry point that
	 * may make more than one round trip, and a learner who pasted an article is
	 * owed a number rather than a spinner that sits still for a minute. The
	 * single-call paths ignore it, so passing it is always harmless.
	 */
	onProgress?: (done: number, total: number) => void;
}

/**
 * Hard ceiling on how many terms travel in one prompt.
 *
 * A few hundred words is well under 1k tokens and buys the model the whole
 * palette it is meant to write with. Past that the list stops informing the
 * text and starts crowding the rules out of the model's attention — and a
 * learner with a thousand words does not need the last four hundred to be in
 * *this* piece. Enforced by a deterministic trim-then-slice, like
 * `MAX_ABOUT_CHARS`, rather than by asking the model to skim.
 */
export const MAX_VOCABULARY_TERMS = 400;

/**
 * How many words one text can be pointed at.
 *
 * Every focus word must be used, and a text of six to twelve sentences that has
 * to work a longer list in stops being a text and becomes a bingo card.
 */
export const MAX_FOCUS_WORDS = 12;

/** Enough for "my neighbour's cat and the postman", short enough to stay a topic. */
export const MAX_TOPIC_CHARS = 120;

/**
 * How long a text is, by level. Sentences, not words: a beginner sentence is
 * five words and an advanced one is twenty, so counting sentences already
 * scales the reading with the reader.
 */
export const SENTENCES_BY_LEVEL = {
	beginner: 6,
	elementary: 8,
	intermediate: 10,
	advanced: 12
} as const satisfies Record<Level, number>;

/**
 * The glossary rules, shared verbatim with `./annotate-call`.
 *
 * Both calls fill the same field for the same consumer, so the two prompts say
 * the same thing by construction rather than by whoever edits one remembering
 * the other. Still a static string on both sides, so nothing about prompt
 * caching changes.
 *
 * The two rules after the first are what make the glossary *land*. Matching is
 * `wordKey` — trimmed, NFC, lower-cased, spaces collapsed — and nothing else: no
 * stemmer, no dictionary, no base-form lookup (the entry's `reading` only ever
 * chooses *between* entries that already match). So a gloss for the base form of a word the
 * text uses inflected matches nothing, and the learner taps a word the app has
 * no answer for. And a model told "never gloss what is already in vocabulary"
 * will happily read 朋友 in the list as covering 小朋友, or 学 as covering 学习,
 * because to a reader it does — but not to a character-for-character match.
 * Both defects arrive as the same symptom (a `plain` word with nothing behind
 * it), and both are prompt bugs, so they are fixed here.
 */
export const GLOSSARY_RULES = [
	'- glossary: every word the text uses that is NOT in "vocabulary" gets an entry, with its "reading" under the rule above and its "meaning" in the NATIVE language.',
	'- "term" is the form the text actually uses, character for character — never a base or dictionary form. The app matches it against the text literally, so an inflected or conjugated word is glossed as it stands; name the base form in "meaning" if that helps.',
	'- A word is in "vocabulary" only when the identical term is listed there. A longer word that merely contains one, or a derived or inflected form of one, is a different word and gets its own entry (学 does not cover 学习; "walk" does not cover "walked").',
	'- For a language written WITHOUT spaces between words (Chinese, Japanese, Thai, Lao, Khmer) the glossary is also how the app splits the text into words, so a multi-character word left out of it is a word the learner cannot tap. Be complete.'
];

/**
 * The system prompt: static, terse, and carrying the four rules that decide
 * whether the result is readable.
 *
 * - **Built from the vocabulary.** Left to itself the model writes at the level
 *   it thinks "beginner" means, which is its own vocabulary shrunk, not the
 *   learner's. The whole premise of the feature is that the app knows which
 *   words those are.
 * - **A few new words, and all of them glossed.** Comprehensible input is
 *   *slightly* beyond what you have; a text with nothing new in it teaches
 *   nothing, and one with an unglossed stranger in it stops the reader dead.
 *   The glossary is what makes the strangers affordable.
 * - **The glossary is also the segmenter.** For Chinese, Japanese and their
 *   neighbours there are no spaces to split on, so the terms the model lists are
 *   literally how the app cuts the text into tappable words (`./tokenize`). A
 *   missing entry there is not a missing gloss, it is a word rendered one
 *   character at a time.
 * - **Reading and translation.** The `TargetText` rule the rest of the app
 *   already runs on: the Latin reading travels with the string it annotates, and
 *   is `null` for languages written in the Latin script.
 */
const SYSTEM_PROMPT = [
	'You write short reading texts for language learners. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"title","sentences":[{"text","reading","translation"}],"glossary":[{"term","reading","meaning"}]}',
	'"text" is one sentence of the piece, in the TARGET language. One array entry per sentence, in reading order, exactly "sentenceCount" of them.',
	'"reading" is the Latin-script reading of that sentence: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. It is ALWAYS null when the target language is written in the Latin script.',
	'"translation" is that same sentence in the NATIVE language.',
	'"title" is short — a few words — and in the TARGET language.',
	'Rules:',
	'- One coherent piece: a story, a dialogue, a note, a short article. Not a list of unrelated example sentences. It has a beginning and an end, and the last sentence finishes it.',
	'- "vocabulary" is everything the learner can already read, and it is what you build with: most of the text is made of those words.',
	'- Every word in "focus" appears at least once, used naturally. They are what this text is for.',
	'- A few words outside "vocabulary" are welcome and wanted — this is comprehension practice, not a drill — but a sentence should never have more than one of them.',
	...GLOSSARY_RULES,
	'- Write at the learner\'s "level": sentence length, tense range and register all follow it.',
	'- With a "topic", the whole piece is about it, and "interests" then only colour the details. With no topic, take the subject from "interests".',
	'- "about" is the learner in their own words. Set the piece in their life where it fits; never recite it back to them and never contradict it.',
	'- Voice: something a person would really write or say. No textbook filler, no sentence whose only job is to use a word, no sentence that opens by announcing what the text is about.'
].join('\n');

/** How many sentences a text at this level runs to. */
export function sentenceCountFor(level: Level): number {
	return SENTENCES_BY_LEVEL[level] ?? SENTENCES_BY_LEVEL.beginner;
}

/** Trim, drop blanks, dedupe, and cap — deterministically, in the order given. */
function cappedTerms(terms: readonly string[], limit: number): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const term of terms) {
		const trimmed = term.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
		if (out.length >= limit) break;
	}
	return out;
}

/** Builds the two messages for one write call. */
export function buildGeneratePrompt(args: GenerateTextArgs): ChatMessage[] {
	const { profile } = args;
	const topic = args.topic?.trim().slice(0, MAX_TOPIC_CHARS);
	const about = profile.about?.trim().slice(0, MAX_ABOUT_CHARS);

	const payload: Record<string, unknown> = {
		native: profile.nativeLanguage,
		target: profile.targetLanguage,
		level: profile.level,
		sentenceCount: sentenceCountFor(profile.level),
		// Before `interests`, as in the batch prompt: the topic outranks them, and
		// models weight earlier keys more heavily.
		...(topic ? { topic } : {}),
		interests: profile.interests,
		...(about ? { about } : {}),
		focus: args.focus.slice(0, MAX_FOCUS_WORDS).map((word) => ({ t: word.term, m: word.meaning })),
		vocabulary: cappedTerms(args.vocabulary, MAX_VOCABULARY_TERMS)
	};

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/** `null`/blank normalized away, so a missing annotation is one state, not three. */
function trimmed(value: string | null | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

/**
 * Turns one glossary row into a {@link GlossEntry}, or `undefined` when it says
 * nothing. Blank rows are dropped rather than rejected: a gloss the model
 * fumbled costs that word its card, never the text.
 */
export function toGlossEntry(raw: {
	term: string;
	reading?: string | null;
	meaning: string;
}): GlossEntry | undefined {
	const term = raw.term.trim();
	const meaning = trimmed(raw.meaning);
	if (!term || !meaning) return undefined;
	const reading = trimmed(raw.reading);
	return { term, meaning, ...(reading ? { reading } : {}) };
}

/**
 * The glossary, cleaned and deduped by {@link cardKey}. Shared with
 * `./annotate-call`.
 *
 * By card rather than by term, so a text that uses both readings of a homograph
 * can carry both glosses — 长 as `cháng` and 长 as `zhǎng` are two entries, and
 * `./annotate` picks between them with the reading the tokenizer derived from
 * the sentence. An entry with no reading still keys as its bare term, which
 * keeps the old rule exactly where nothing distinguishes two rows: first wins.
 */
export function toGlossary(
	rows: readonly { term: string; reading?: string | null; meaning: string }[]
): GlossEntry[] {
	const seen = new Set<string>();
	const out: GlossEntry[] = [];
	for (const row of rows) {
		const entry = toGlossEntry(row);
		if (!entry) continue;
		const key = cardKey(entry.term, entry.reading);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

/**
 * Reads one write completion.
 *
 * Strict about the envelope and forgiving inside it, the split the rest of the
 * app makes: a text with no sentences is nothing to read and throws, while a
 * sentence that lost its translation is still a sentence and keeps its place.
 */
export function parseGeneratedText(raw: string): ReadingTextDraft {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not return a text. Try again.', { cause });
	}

	const parsed = generatedTextSchema.safeParse(json);
	if (!parsed.success) {
		throw new LlmError('bad-response', 'The model returned a text in an unexpected shape.');
	}

	const sentences: ReadingSentence[] = [];
	for (const raw of parsed.data.sentences) {
		const text = raw.text.trim();
		if (!text) continue;
		const reading = trimmed(raw.reading);
		const translation = trimmed(raw.translation);
		sentences.push({
			text,
			...(reading ? { reading } : {}),
			...(translation ? { translation } : {})
		});
	}

	if (sentences.length === 0) {
		throw new LlmError('bad-response', 'The model returned a text with no sentences. Try again.');
	}

	return {
		title: parsed.data.title.trim(),
		sentences,
		glossary: toGlossary(parsed.data.glossary)
	};
}

/** The real write call; {@link generateReadingText} in `./index` picks it or the mock. */
export async function requestGeneratedText(
	args: GenerateTextArgs,
	opts: ReadingOptions = {}
): Promise<ReadingTextDraft> {
	const completion = await chatCompletion({
		messages: buildGeneratePrompt(args),
		responseFormat: { schema: generatedTextJsonSchema(), name: GENERATED_TEXT_SCHEMA_NAME },
		// No `maxTokens`, like the lesson batch: a thinking model (the default
		// Gemini is one) spends its reasoning against the cap before writing a
		// byte of JSON, and a 4000-token ceiling came back as empty content.
		temperature: 0.9,
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn
	});

	return { ...parseGeneratedText(completion.content), usage: completion.usage };
}

/**
 * Re-exported because the `about` cap is shared with lesson generation and a
 * caller here should not have to know it lives in the other module.
 */
export { MAX_ABOUT_CHARS };
