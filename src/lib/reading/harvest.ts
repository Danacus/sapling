/**
 * The words of a text a learner might add: every word in it that is not yet
 * in their garden, once each, in the order the text first uses them.
 *
 * Pure, like the rest of `$lib/reading`: it reads the words `annotateSentence`
 * already made of each segment — the same tokens, the same statuses and the
 * same readings the reader shows — so a word here is exactly a word there, and
 * a reading is the frontend's own (`$lib/romanize`), never a model's. The
 * `/read/[id]/words` page lists them, asks `glossWords` for the meanings of the
 * ones ticked, and files them with `addWords`.
 */

import type { ReadingWord } from './annotate';
import { sentenceAt } from './pages';

/** One segment's words, with the segment they were made from. */
export interface AnnotatedSegment {
	text: string;
	words: ReadingWord[];
}

export interface WordCandidate {
	/** `wordKey` of the word, and its reading where it has one: what makes it one entry. */
	id: string;
	/** As the text first spells it. */
	term: string;
	/** The token's own reading, `null` for a word with none (any Latin-script word). */
	reading: string | null;
	/** How many times the text uses it. */
	count: number;
	/** The sentence it first stands in: what picks its sense when a meaning is asked for. */
	sentence: string;
	/** A legacy "known" mark: shown, never ticked for the learner. */
	known: boolean;
}

/** Letters in it: a number or a symbol is not a word to learn. */
function isWordLike(text: string): boolean {
	return /\p{L}/u.test(text);
}

/**
 * Every word of `segments` that is not `tracked`, once per spelling and
 * reading — 长 `cháng` and 长 `zhǎng` are two entries, as they are two cards —
 * in order of first use, with how often it comes back.
 */
export function harvestWords(segments: readonly AnnotatedSegment[]): WordCandidate[] {
	const found = new Map<string, WordCandidate>();
	for (const segment of segments) {
		let offset = 0;
		for (const word of segment.words) {
			const at = offset;
			offset += word.text.length;
			if (!word.key || word.status === 'tracked' || !isWordLike(word.text)) continue;
			const id = `${word.key}|${word.reading ?? ''}`;
			const seen = found.get(id);
			if (seen) {
				seen.count += 1;
				continue;
			}
			found.set(id, {
				id,
				term: word.text,
				reading: word.reading,
				count: 1,
				sentence: sentenceAt(segment.text, at),
				known: word.status === 'known'
			});
		}
	}
	return [...found.values()];
}
