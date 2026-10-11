/**
 * The challenge decisions that live in Rust (`crates/sapling-challenges`):
 * grading, what a served challenge shows, and the session and top-up planners,
 * through the wasm build's synchronous `challenges` export. Nothing crosses
 * but JSON — not even a word count: a length the difficulty model learns from
 * is the model's own `words_in`, identical on every device and in the Worker.
 */

import type { Challenges } from '$lib/db/generated/challenges';
import type { Word } from '$lib/db/generated/index';
import { challenges } from '$lib/db/wasm/sapling_core';
import type { KnowledgeItem } from '$lib/types';

/** One challenge decision by name. Throws the core's message for a malformed call. */
export function callChallenges<M extends keyof Challenges>(
	method: M,
	args: Parameters<Challenges[M]>[0]
): ReturnType<Challenges[M]> {
	return JSON.parse(challenges(method, JSON.stringify([args]))) as ReturnType<Challenges[M]>;
}

/** The part of each item the decisions read, so a large vocabulary crosses light. */
export function asWords(items: readonly KnowledgeItem[]): Word[] {
	return items.map(({ id, term, meaning, romanization, srs, skill }) => ({
		id,
		term,
		meaning,
		...(romanization === undefined ? {} : { romanization }),
		...(srs === undefined ? {} : { srs }),
		...(skill === undefined ? {} : { skill })
	}));
}
