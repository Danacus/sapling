/**
 * One line, in the learner's own language.
 *
 * A stored text carries no translations — it is only the text — so a line the
 * learner cannot make out is translated when they ask, one segment at a time:
 * the cue on screen in the follow view, each segment of the page in the paged
 * one. A segment is the unit because it is what the source cut and what the
 * reader already indexes everything by, so the answer lines up with the line it
 * belongs to with no alignment step at all — the page keys it by segment index
 * and that is the whole of the bookkeeping.
 *
 * Deliberately minimal on both sides, because it is a quick request made
 * mid-read: the line, the two languages and the title in; one string out. No
 * notes, no alternatives, no word-by-word gloss — a word is what the card is
 * for.
 *
 * Stateless like the rest of the module — no `$lib/db` — and paid, so only a
 * button fires it; the page keeps what comes back for the rest of that open and
 * never stores it.
 */

import { LlmError, chatCompletion, stripFences } from '$lib/llm';
import type { BatchProfile, ChatMessage } from '$lib/llm';
import type { ReadingOptions } from './generate';
import {
	LINE_TRANSLATION_SCHEMA_NAME,
	lineTranslationJsonSchema,
	lineTranslationSchema
} from './schemas';

export interface TranslateLineArgs {
	profile: BatchProfile;
	/** One segment of the text, verbatim. */
	text: string;
	/** The text's title, when there is one: a little more context for nothing. */
	title?: string;
}

/**
 * Static, so it caches across every line of every text. The one rule of its
 * own is faithfulness: a learner comparing the translation with the line wants
 * to find each part of one in the other, and a free rewrite defeats that.
 */
const SYSTEM_PROMPT = [
	'A language learner is reading a text and asked for a translation of one line. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"translation"}',
	'"translation" is "text" translated into the NATIVE language: faithful and natural, keeping its meaning, tone and register, close enough to the original that the learner can match its parts. Only the translation — no notes, no alternatives, no explanation.'
].join('\n');

/** Builds the two messages for one line. */
export function buildTranslatePrompt(args: TranslateLineArgs): ChatMessage[] {
	const { profile } = args;
	const title = args.title?.trim();

	const payload: Record<string, unknown> = {
		native: profile.nativeLanguage,
		target: profile.targetLanguage,
		text: args.text.trim(),
		...(title ? { title } : {})
	};

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/**
 * Reads one translation completion. All-or-nothing: a blank translation is
 * nothing to show, so an unusable reply throws and the page shows the error
 * under the line instead.
 */
export function parseLineTranslation(raw: string): string {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not translate that line. Try again.', {
			cause
		});
	}

	const parsed = lineTranslationSchema.safeParse(json);
	const translation = parsed.success ? parsed.data.translation.trim() : '';
	if (!translation) {
		throw new LlmError('bad-response', 'The model did not translate that line. Try again.');
	}
	return translation;
}

/** The real call; {@link translateLine} in `./index` picks it or the mock. */
export async function requestLineTranslation(
	args: TranslateLineArgs,
	opts: ReadingOptions = {}
): Promise<string> {
	const completion = await chatCompletion({
		messages: buildTranslatePrompt(args),
		responseFormat: {
			schema: lineTranslationJsonSchema(),
			name: LINE_TRANSLATION_SCHEMA_NAME
		},
		// No `maxTokens` — see `requestGeneratedText`.
		temperature: 0.3,
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn
	});

	return parseLineTranslation(completion.content);
}
