/**
 * Pieces shared by more than one tool: the term-matching rule, the failure
 * shape, and the zod fragments the argument schemas are built from.
 *
 * A leaf module — zod, `$lib/types` and `./def` only — so every tool can import
 * it without ordering the registry.
 */

import { z } from 'zod';
import type { KnowledgeItem } from '$lib/types';
import type { ToolOutcome } from './def';

/**
 * Case/whitespace-insensitive key used to tell whether two terms name the same
 * word — the same rule `deriveRecentMistakes` in `$lib/session/engine` applies
 * when it folds missed words into prompt hints, re-implemented here rather than
 * shared, because neither module should be able to change the other's notion of
 * sameness by accident.
 *
 * It is what makes "Hola" and "hola" one word, so the assistant cannot fork a
 * learner's SRS history in two by adding a word they already have — and since
 * `add_words` is now the *only* way vocabulary enters the collection, this is
 * the app's one guard against a duplicate word.
 */
export function termKey(term: string): string {
	return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The item the learner means by `term`, or `undefined`. */
export function findByTerm(items: KnowledgeItem[], term: string): KnowledgeItem | undefined {
	const key = termKey(term);
	return items.find((item) => termKey(item.term) === key);
}

/**
 * A domain failure the model is expected to read and recover from — a word that
 * is not in the list, arguments that do not parse. Never an exception: see the
 * note in `./def`.
 */
export function toolFailure(message: string): ToolOutcome {
	return { result: { error: message }, summary: message, ok: false };
}

/** Trimmed text, or `undefined` for blank/absent — never an empty string. */
export function trimmedOrUndefined(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** `{ key: value }` when there is one, `{}` otherwise — for optional item fields. */
export function optionalField<K extends string>(
	key: K,
	value: string | undefined
): Record<K, string> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/** Non-blank text. */
export const nonEmpty = z.string().trim().min(1);

/**
 * Optional text, `null` included: models emit `null` for "not applicable" far
 * more often than they omit a key (the same reason the generation schemas are
 * `.nullish()`), and a tool argument is not worth failing over.
 */
export const optionalText = z.string().nullish();

/** Whether a word is vocabulary or a grammar point; vocabulary unless said. */
export const kindSchema = z.enum(['vocab', 'grammar']);

/** One word as a tool reports it back: content only, no id, no card, no history. */
export interface WordView {
	term: string;
	meaning: string;
	romanization?: string;
	notes?: string;
}

/** {@link WordView} for one stored item, blank optionals omitted. */
export function wordView(item: KnowledgeItem): WordView {
	return {
		term: item.term,
		meaning: item.meaning,
		...optionalField('romanization', item.romanization),
		...optionalField('notes', item.notes)
	};
}

/** `1 word` / `3 words`. */
export function countWords(n: number): string {
	return `${n} word${n === 1 ? '' : 's'}`;
}
