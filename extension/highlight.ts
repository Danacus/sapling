// What the page script underlines, decided without the DOM: a text node's
// tokens and the cached list in, offsets and a mark per word out.

import type { InboxEntry, ListedTerm, TermList } from '$lib/extension/protocol';
import { sentenceAt } from '$lib/reading/pages';
import type { RomanizedToken } from '$lib/romanize/types';
import { readingKey, termKey } from '$lib/text/keys';

export type Mark = 'new' | 'learning' | 'known' | 'collected';
export const MARKS: readonly Mark[] = ['new', 'learning', 'known', 'collected'];

export interface TermIndex {
	byKey: Map<string, ListedTerm[]>;
	collected: Set<string>;
	/** Every listed and collected spelling, for the tokenizer to keep whole. */
	terms: string[];
}

export function buildIndex(list: TermList | undefined, inbox: readonly InboxEntry[]): TermIndex {
	const byKey = new Map<string, ListedTerm[]>();
	for (const term of list?.terms ?? []) {
		const key = termKey(term.term);
		byKey.set(key, [...(byKey.get(key) ?? []), term]);
	}
	const collected = new Set(inbox.map((entry) => termKey(entry.term)));
	const terms = [
		...(list?.terms ?? []).map((term) => term.term),
		...inbox.map((entry) => entry.term)
	];
	return { byKey, collected, terms };
}

/** The listed word a token is: by spelling, the token's reading picking between homographs. */
export function lookUp(
	index: TermIndex,
	text: string,
	reading: string | null
): ListedTerm | undefined {
	const candidates = index.byKey.get(termKey(text));
	if (!candidates) return undefined;
	if (reading) {
		const wanted = readingKey(reading);
		const match = candidates.find((term) => term.reading && readingKey(term.reading) === wanted);
		if (match) return match;
	}
	return candidates[0];
}

export interface Span {
	/** UTF-16 offsets into the text node, which is what a DOM `Range` takes. */
	start: number;
	end: number;
	token: RomanizedToken;
}

function hasLetter(text: string): boolean {
	return /\p{L}/u.test(text);
}

/** Each word token with where it sits; punctuation and whitespace are skipped. */
export function wordSpans(tokens: readonly RomanizedToken[]): Span[] {
	const spans: Span[] = [];
	let at = 0;
	for (const token of tokens) {
		const start = at;
		at += token.text.length;
		if (hasLetter(token.text)) spans.push({ start, end: at, token });
	}
	return spans;
}

export interface MarkedSpan extends Span {
	mark: Mark;
}

/** The words worth underlining: listed ones by status, else collected ones. */
export function marksOf(tokens: readonly RomanizedToken[], index: TermIndex): MarkedSpan[] {
	return wordSpans(tokens).flatMap((span): MarkedSpan[] => {
		const listed = lookUp(index, span.token.text, span.token.reading);
		if (listed) return [{ ...span, mark: listed.status }];
		return index.collected.has(termKey(span.token.text)) ? [{ ...span, mark: 'collected' }] : [];
	});
}

/** The word holding the character at `index`. */
export function spanAt(tokens: readonly RomanizedToken[], index: number): Span | undefined {
	return wordSpans(tokens).find((span) => index >= span.start && index < span.end);
}

/**
 * The sentence around `offset`. The page's layout whitespace is collapsed first,
 * since ICU ends a sentence at every newline and HTML source is full of them.
 */
export function sentenceAround(text: string, offset: number): string {
	const collapse = (part: string) => part.replace(/\s+/g, ' ');
	const at = collapse(text.slice(0, Math.max(0, offset))).length;
	return sentenceAt(collapse(text), at).trim();
}
