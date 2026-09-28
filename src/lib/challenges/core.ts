/**
 * The challenge decisions that live in Rust (`crates/sapling-challenges`):
 * grading, what a served challenge shows, and the session and top-up planners,
 * through the wasm build's synchronous `challenges` export. This module lends
 * the one thing Rust cannot know, how many words a text holds —
 * `Intl.Segmenter` behind `$lib/text` — and nothing else crosses but JSON.
 */

import type { Challenges } from '$lib/db/generated/challenges';
import type { Word } from '$lib/db/generated/index';
import { challenges } from '$lib/db/wasm/sapling_core';
import { segmentWords } from '$lib/text';
import type { KnowledgeItem } from '$lib/types';

function countWords(text: string): number {
	return segmentWords(text).filter((segment) => segment.isWord).length;
}

/** One challenge decision by name. Throws the core's message for a malformed call. */
export function callChallenges<M extends keyof Challenges>(
	method: M,
	args: Parameters<Challenges[M]>[0]
): ReturnType<Challenges[M]> {
	return JSON.parse(challenges(method, JSON.stringify([args]), countWords)) as ReturnType<
		Challenges[M]
	>;
}

/** The part of each item the decisions read, so a large vocabulary crosses light. */
export function asWords(items: readonly KnowledgeItem[]): Word[] {
	return items.map(({ id, term, meaning, romanization, srs }) => ({
		id,
		term,
		meaning,
		...(romanization === undefined ? {} : { romanization }),
		...(srs === undefined ? {} : { srs })
	}));
}
