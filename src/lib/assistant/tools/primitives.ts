/**
 * Pieces shared by more than one tool: the term-matching rule, the failure
 * shape, and the zod fragments the argument schemas are built from.
 *
 * A leaf module — zod, `$lib/types`, `$lib/text` (dependency-free) and `./def`
 * only — so every tool can import it without ordering the registry.
 */

import { z } from 'zod';
import { readingKey, sameCard, termKey } from '$lib/text';
import type { KnowledgeItem } from '$lib/types';
import type { ToolOutcome } from './def';

/**
 * The one normalization, shared with the lesson resolver, the session engine and
 * reading mode (`$lib/text`) rather than re-implemented per module — four
 * private one-liners is four chances for two sides of a lookup to disagree.
 *
 * It is what makes "Hola" and "hola" one word, so the assistant cannot fork a
 * learner's SRS history in two by adding a word they already have — and since
 * `add_words` is the *only* way vocabulary enters the collection, this is the
 * app's one guard against a duplicate word.
 */
export { readingKey, sameCard, termKey };

/**
 * Every item that shares a spelling with `term`, in list order.
 *
 * Usually zero or one. It is more than one exactly when the learner keeps a
 * homograph as two cards — 长 as `cháng` and 长 as `zhǎng` — which `add_words`
 * now allows and which the tools addressing a word *by term* therefore have to
 * be able to see.
 */
export function findAllByTerm(items: KnowledgeItem[], term: string): KnowledgeItem[] {
	const key = termKey(term);
	return items.filter((item) => termKey(item.term) === key);
}

/**
 * The one item the learner means, or `undefined` when there is no such word —
 * *or* when the term names two and nothing says which.
 *
 * A `romanization` picks between siblings; with one candidate it is ignored,
 * because the model reading a word back from `list_words` should not have to
 * spell its reading identically to address it. Ambiguity is deliberately
 * `undefined` rather than a guess: `remove_word` cannot be undone, and choosing
 * one of two 长s on the learner's behalf is exactly the failure the second card
 * was created to prevent. {@link describeTermMiss} writes what to say about it.
 */
export function findByTerm(
	items: KnowledgeItem[],
	term: string,
	romanization?: string
): KnowledgeItem | undefined {
	const candidates = findAllByTerm(items, term);
	if (candidates.length <= 1) return candidates[0];

	const reading = romanization?.trim();
	if (!reading) return undefined;
	const key = readingKey(reading);
	return candidates.find((item) => item.romanization && readingKey(item.romanization) === key);
}

/**
 * Why {@link findByTerm} came back empty, written for the model to act on:
 * either the word is not there, or it named a homograph and has to say which
 * reading it means.
 */
export function describeTermMiss(
	items: KnowledgeItem[],
	term: string,
	romanization?: string
): string {
	const candidates = findAllByTerm(items, term);
	if (candidates.length <= 1) return `no word "${term}" in the list`;

	const readings = candidates.map((item) => item.romanization ?? '(no romanization)').join(', ');
	return romanization?.trim()
		? `no word "${term}" with romanization "${romanization.trim()}" in the list; it has ${readings}`
		: `"${term}" is in the list ${candidates.length} times (${readings}); pass "romanization" to say which one you mean`;
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
