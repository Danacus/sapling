/**
 * The third door: one word, explained where it stands.
 *
 * The other two calls buy a whole text. This one buys a single glossary row,
 * and it exists because the glossary is never quite complete: a model writing a
 * long import thins the tail out, and a word it decided the learner already had
 * arrives as `plain` — tappable, with nothing behind it. The reader used to
 * offer only an empty "What does it mean?" box there, which asks the learner to
 * answer the question they just asked.
 *
 * Two things make this call different from asking a dictionary. The whole
 * sentence travels with the word, so a polysemous word comes back in the sense
 * it is actually being used in rather than with a list of four; and the term is
 * echoed back verbatim, because what comes back is merged into the text's
 * glossary and matched against the token character for character
 * (`./annotate`).
 *
 * Stateless like the rest of the module — no `$lib/db` — and paid, which is why
 * only a button ever fires it. A tap is free and must stay free.
 */

import { LlmError, chatCompletion, stripFences } from '$lib/llm';
import type { BatchProfile, ChatMessage } from '$lib/llm';
import type { GlossEntry } from '$lib/types';
import { toGlossEntry } from './generate';
import type { ReadingOptions } from './generate';
import { LOOKED_UP_WORD_SCHEMA_NAME, glossEntrySchema, lookedUpWordJsonSchema } from './schemas';

export interface LookupWordArgs {
	profile: BatchProfile;
	/** The tapped word, exactly as the text spells it. */
	term: string;
	/** The whole sentence it sits in — what makes the answer this word's, here. */
	sentence: string;
	/** The text's title, when there is one: a little more context for nothing. */
	title?: string;
}

/**
 * Static and tiny. The reading rule is the app's one `TargetText` rule, word for
 * word as the other two calls state it, and the only rule of its own is that the
 * meaning is *this sentence's* — a glossary the learner asked for one row at a
 * time is worth nothing if it comes back as a dictionary entry.
 */
const SYSTEM_PROMPT = [
	'A language learner tapped one word while reading. Explain that word as it is used in the sentence they were reading. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"term","reading","meaning"}',
	'"term" is the word you were given, echoed back exactly, character for character. Never a base or dictionary form of it.',
	'"reading" is the Latin-script reading of that word: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. It is ALWAYS null when the target language is written in the Latin script.',
	'"meaning" is what the word means HERE, in this sentence, in the NATIVE language: one line, no examples and no grammar lecture. A word with several senses gets the one this sentence uses.'
].join('\n');

/** Builds the two messages for one lookup. */
export function buildLookupPrompt(args: LookupWordArgs): ChatMessage[] {
	const { profile } = args;
	const title = args.title?.trim();

	const payload: Record<string, unknown> = {
		native: profile.nativeLanguage,
		target: profile.targetLanguage,
		level: profile.level,
		// The word first: it is the question, and models weight earlier keys more
		// heavily. The sentence is where it stands, the title is only colour.
		term: args.term.trim(),
		sentence: args.sentence.trim(),
		...(title ? { title } : {})
	};

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/**
 * Reads one lookup completion.
 *
 * All-or-nothing, unlike the two text parsers: a text that lost a translation is
 * still a text, but a gloss that lost its meaning is nothing to render, so an
 * unusable reply throws and the card shows the error where the meaning would
 * have been.
 *
 * `term` is taken from the *request*, not the reply. The model is told to echo
 * it and mostly does, but the entry is about to be matched against a token
 * character for character, and a model that helpfully returned the dictionary
 * form would leave the word `plain` with no sign that anything had happened —
 * which is the exact defect this call was added to fix.
 */
export function parseLookedUpWord(raw: string, term: string): GlossEntry {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not explain that word. Try again.', {
			cause
		});
	}

	const parsed = glossEntrySchema.safeParse(json);
	const entry = parsed.success ? toGlossEntry({ ...parsed.data, term }) : undefined;
	if (!entry) {
		throw new LlmError('bad-response', 'The model did not explain that word. Try again.');
	}
	return entry;
}

/** The real lookup; {@link lookUpWord} in `./index` picks it or the mock. */
export async function requestLookedUpWord(
	args: LookupWordArgs,
	opts: ReadingOptions = {}
): Promise<GlossEntry> {
	const completion = await chatCompletion({
		messages: buildLookupPrompt(args),
		responseFormat: { schema: lookedUpWordJsonSchema(), name: LOOKED_UP_WORD_SCHEMA_NAME },
		// No `maxTokens` — see `requestGeneratedText`; a thinking model spends its
		// reasoning against the cap before writing a byte of JSON.
		temperature: 0.3,
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn
	});

	return parseLookedUpWord(completion.content, args.term);
}
