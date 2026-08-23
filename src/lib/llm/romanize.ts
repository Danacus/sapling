/**
 * Backfill: readings for words that never got one.
 *
 * Vocabulary introduced before the generator emitted `romanization` is stored
 * without it, and there is no way to derive pinyin or romaji locally — so this
 * is the one place the app spends tokens on something that is not a lesson. It
 * is worth it exactly once, from a button in Settings, and it is deliberately
 * cheap: no profile, no examples, no per-word call. One request carries every
 * unreadable term at once and gets back nothing but `{id, romanization}` pairs,
 * which is a few tokens per word.
 *
 * Stateless like the rest of `$lib/llm`: terms in, readings out. The caller
 * decides what to persist.
 */

import { z } from 'zod';

import { chatCompletion, LlmError } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';
import { stripFences } from './generate';

/** One word that needs a reading. `id` is only a handle for the round trip. */
export interface RomanizeItem {
	id: string;
	term: string;
}

export interface RomanizeArgs {
	items: RomanizeItem[];
	/** The learner's target language, which picks the romanization scheme. */
	targetLanguage: string;
}

export interface RomanizeOptions {
	fetchFn?: FetchLike;
	model?: string;
	apiKey?: string;
	signal?: AbortSignal;
}

export interface RomanizeResult {
	/** Item id → Latin reading. Ids the model invented are not in here. */
	readings: Map<string, string>;
	usage: TokenUsage;
}

/** The reply envelope; anything else is a `bad-response`. */
export const romanizationsSchema = z.object({
	readings: z.array(
		z.object({
			id: z.string(),
			romanization: z.string()
		})
	)
});

/** Name used for the structured-output schema. */
export const ROMANIZE_SCHEMA_NAME = 'romanizations';

/**
 * Hand-written rather than derived from the zod schema above: it is four keys
 * deep, and `strict: true` structured outputs want every property listed in
 * `required` with `additionalProperties: false` — which is easier to just write
 * than to post-process for one call site.
 */
export function romanizeJsonSchema(): Record<string, unknown> {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['readings'],
		properties: {
			readings: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['id', 'romanization'],
					properties: {
						id: { type: 'string' },
						romanization: { type: 'string' }
					}
				}
			}
		}
	};
}

/**
 * Static and short, so it caches well and costs nothing to repeat. Naming the
 * scheme per language matters more than it looks: asked for "the romanization"
 * of a Mandarin word, models will hand back toneless pinyin about as often as
 * the tone-marked form the rest of the app displays.
 */
const SYSTEM_PROMPT = [
	'You transliterate words into the Latin alphabet. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"readings":[{"id","romanization"}]}',
	'For every item given, return its standard Latin-script reading: pinyin WITH tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme for any other language.',
	'Reuse the id you were given, exactly. One entry per item, no extras, no commentary.'
].join('\n');

/** Builds the two messages for one backfill call. */
export function buildRomanizePrompt(args: RomanizeArgs): ChatMessage[] {
	const payload = {
		language: args.targetLanguage,
		items: args.items.map((item) => ({ id: item.id, t: item.term }))
	};
	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/**
 * Reads one backfill completion into `id → reading`.
 *
 * `knownIds` is the guard that makes the result safe to write straight to the
 * database: a model that invents an id (or echoes a term where an id belongs)
 * would otherwise have its answer stamped onto whatever happens to match. Blank
 * readings and repeats are dropped for the same reason — a word keeps its
 * missing reading rather than gaining a wrong one.
 *
 * Throws `LlmError('bad-response')` when the envelope itself is unusable; there
 * is nothing to salvage from a reply that is not the shape asked for.
 */
export function parseRomanizations(raw: string, knownIds: Iterable<string>): Map<string, string> {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not return JSON. Try again.', { cause });
	}

	const parsed = romanizationsSchema.safeParse(json);
	if (!parsed.success) {
		throw new LlmError('bad-response', 'The model returned JSON in an unexpected shape. Try again.');
	}

	const wanted = new Set(knownIds);
	const readings = new Map<string, string>();
	for (const entry of parsed.data.readings) {
		const reading = entry.romanization.trim();
		if (!reading || !wanted.has(entry.id) || readings.has(entry.id)) continue;
		readings.set(entry.id, reading);
	}
	return readings;
}

/**
 * Fetches Latin readings for a list of terms in one call.
 *
 * Returns an empty result — and spends nothing — when there is nothing to ask
 * about. Items the model skipped are simply absent from the map; the caller
 * patches what came back and leaves the rest alone.
 */
export async function fillRomanizations(
	args: RomanizeArgs,
	opts: RomanizeOptions = {}
): Promise<RomanizeResult> {
	const items = args.items.filter((item) => item.id && item.term.trim());
	if (items.length === 0) {
		return { readings: new Map(), usage: { promptTokens: 0, completionTokens: 0 } };
	}

	const completion = await chatCompletion({
		messages: buildRomanizePrompt({ ...args, items }),
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn,
		responseFormat: { name: ROMANIZE_SCHEMA_NAME, schema: romanizeJsonSchema() },
		// Transliteration has one right answer; creativity is a defect here.
		temperature: 0
	});

	return {
		readings: parseRomanizations(
			completion.content,
			items.map((item) => item.id)
		),
		usage: completion.usage
	};
}
