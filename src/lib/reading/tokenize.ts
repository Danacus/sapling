/**
 * The fallback tokenizer: cutting a sentence into tappable words when the
 * language has no local romanizer.
 *
 * `$lib/romanize` already does this for Mandarin, and does it better — it
 * romanizes the whole sentence and slices readings per token, which is the only
 * way polyphones come out right. But it exists for exactly one language, and
 * reading mode has to work for every language the learner might paste. So this
 * is the same *shape* with none of the linguistics: it produces
 * {@link RomanizedToken}s with `reading: null` throughout, grouped around the
 * learner's own terms, and `./annotate` accepts either function without knowing
 * which it got.
 *
 * Where the script writes no spaces the cut comes from `segmentWords`
 * (`$lib/text`, ICU's dictionaries via `Intl.Segmenter`) and the learner's own
 * terms are layered on top by greedy longest match. Both halves are needed. ICU
 * alone splits 自行车 into 自行 + 车, which is wrong for a learner who is
 * studying the whole word; terms alone leave every unstudied word as loose
 * characters, so 我们 renders as two taps and two cards. Together the dictionary
 * decides what nobody claimed and the vocabulary overrides it wherever the
 * learner has an opinion.
 *
 * The invariant, inherited from `$lib/romanize` and just as load-bearing:
 * **concatenating every token's `text` reproduces the input exactly.** A caller
 * renders tokens instead of the string and must never have to diff the two.
 */

import type { RomanizedToken } from '$lib/romanize';
import { segmentWords, usesInterWordSpaces } from '$lib/text';

/**
 * The one normalization, used on both sides of every lookup.
 *
 * Trimmed, NFC, lower-cased — and nothing else. No diacritic folding: in the
 * language's own spelling every mark counts, and `ecole` is not `école` (the
 * same line conversation mode draws around its reading comparison). NFC because
 * a term typed with a combining accent and one typed with the precomposed
 * character are the same word, and the learner has no way to tell which they
 * have.
 */
export function wordKey(s: string): string {
	return s.trim().normalize('NFC').toLowerCase();
}

/** Letters, marks and digits: what a word is made of. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/**
 * Characters that join a word rather than ending it, *between* two word
 * characters: `l'école`, `no-one`, `it's`. Never at an edge, so a quoted
 * 'word' and a dash — do not glue themselves on.
 */
const INNER_CHAR = /['’ʼ-]/;

function isWordChar(ch: string): boolean {
	return WORD_CHAR.test(ch);
}

/** One vocabulary term, ready for greedy longest-match. */
interface PreparedTerm {
	key: string;
	/** Length in code points, which is the span it claims in the text. */
	length: number;
}

/**
 * Terms bucketed by their first character, longest first inside each bucket.
 *
 * The bucket is what keeps this linear-ish: a text is walked character by
 * character and a learner may have hundreds of terms, so trying every term at
 * every position would be the one part of reading mode you could feel. Longest
 * first inside the bucket is the greedy rule — 中国人 wins over 中国 at the same
 * position, exactly as in `$lib/romanize/zh`.
 */
function prepareTerms(terms: readonly string[]): Map<string, PreparedTerm[]> {
	const seen = new Set<string>();
	const buckets = new Map<string, PreparedTerm[]>();

	for (const raw of terms) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const key = wordKey(trimmed);
		if (!key || seen.has(key)) continue;
		seen.add(key);

		const chars = [...trimmed];
		const first = wordKey(chars[0]);
		const bucket = buckets.get(first);
		const prepared: PreparedTerm = { key, length: chars.length };
		if (bucket) bucket.push(prepared);
		else buckets.set(first, [prepared]);
	}

	for (const bucket of buckets.values()) bucket.sort((a, b) => b.length - a.length);
	return buckets;
}

/**
 * How many code points a term claims starting at `start`, or `0`.
 *
 * Compared through {@link wordKey} on both sides, so the match is
 * case-insensitive and normalization-insensitive — "Por Favor" in the text
 * matches the term `por favor`, multi-word separator and all.
 *
 * The one thing it refuses is cutting a word in half: in a spaced script the
 * term `por` must not claim the first three letters of `portal`. In an unspaced
 * script the opposite is true — 中国 inside 中国人 is a legitimate match when 中国人
 * is not itself a term — so the guard asks the characters, not the language.
 */
function termSpanAt(
	chars: readonly string[],
	start: number,
	buckets: Map<string, PreparedTerm[]>
): number {
	const bucket = buckets.get(wordKey(chars[start]));
	if (!bucket) return 0;

	for (const term of bucket) {
		const end = start + term.length;
		if (end > chars.length) continue;
		if (!isWordChar(chars[end - 1])) continue;
		if (wordKey(chars.slice(start, end).join('')) !== term.key) continue;
		// A spaced script's word boundary: `por` may not eat into `portal`.
		const next = chars[end];
		if (
			next !== undefined &&
			isWordChar(next) &&
			usesInterWordSpaces(next) &&
			usesInterWordSpaces(chars[end - 1])
		) {
			continue;
		}
		return term.length;
	}
	return 0;
}

/** End of the word run starting at `start`, following the inner-character rule. */
function wordRunEnd(chars: readonly string[], start: number): number {
	let i = start + 1;
	while (i < chars.length) {
		if (isWordChar(chars[i])) {
			i++;
			continue;
		}
		// An apostrophe or hyphen continues the word only when a letter follows.
		if (INNER_CHAR.test(chars[i]) && i + 1 < chars.length && isWordChar(chars[i + 1])) {
			i += 2;
			continue;
		}
		break;
	}
	return i;
}

/**
 * A spaced script: word runs, with terms claiming spans across them.
 *
 * Kept off `segmentWords` deliberately. ICU cuts `no-one` into three segments
 * and would have to be stitched back together, whereas the run rule is one line
 * and gives the reader the token it wants; and a multi-word term like
 * `por favor` has to span a space either way, which is character work, not
 * segment work.
 */
function tokenizeSpaced(chars: readonly string[], buckets: Map<string, PreparedTerm[]>) {
	const tokens: RomanizedToken[] = [];
	let i = 0;
	while (i < chars.length) {
		if (!isWordChar(chars[i])) {
			let end = i + 1;
			while (end < chars.length && !isWordChar(chars[end])) end++;
			tokens.push({ text: chars.slice(i, end).join(''), reading: null });
			i = end;
			continue;
		}
		const span = termSpanAt(chars, i, buckets);
		const end = span > 0 ? i + span : wordRunEnd(chars, i);
		tokens.push({ text: chars.slice(i, end).join(''), reading: null });
		i = end;
	}
	return tokens;
}

/** Where each segment ends, in code points, indexed by the code points it covers. */
function segmentEnds(text: string, chars: readonly string[]): { end: number; isWord: boolean }[] {
	const out: { end: number; isWord: boolean }[] = new Array(chars.length);
	let pos = 0;
	for (const segment of segmentWords(text)) {
		const length = [...segment.text].length;
		pos += length;
		for (let k = 0; k < length; k++) out[pos - length + k] = { end: pos, isWord: segment.isWord };
	}
	return out;
}

/**
 * An unspaced script: ICU's boundaries, with the learner's terms on top.
 *
 * Term matching runs over *characters*, not segments, so a term may span
 * several segments (自行 + 车 → 自行车) or end inside one. When it ends inside
 * one, the rest of that segment becomes its own token — the alternative is
 * losing the boundary altogether, and a stub token is still a real word's tail.
 */
function tokenizeSegmented(
	text: string,
	chars: readonly string[],
	buckets: Map<string, PreparedTerm[]>
) {
	const bounds = segmentEnds(text, chars);
	const tokens: RomanizedToken[] = [];

	let i = 0;
	while (i < chars.length) {
		const here = bounds[i];
		if (!here?.isWord) {
			// Consecutive non-word segments read as one run of punctuation.
			let end = here?.end ?? i + 1;
			while (end < chars.length && !bounds[end]?.isWord) end = bounds[end]?.end ?? end + 1;
			tokens.push({ text: chars.slice(i, end).join(''), reading: null });
			i = end;
			continue;
		}
		const span = termSpanAt(chars, i, buckets);
		const end = span > 0 ? i + span : here.end;
		tokens.push({ text: chars.slice(i, end).join(''), reading: null });
		i = end;
	}

	return tokens;
}

/**
 * Splits `text` into display tokens, grouped around `terms`, with no readings.
 *
 * Which of the two walks runs is decided once, from the whole string — the same
 * rule `joinTokens` uses — so a Chinese sentence with an English loanword in it
 * is segmented as Chinese, and ICU still hands back that loanword as one word.
 *
 * The empty string yields an empty array. In every other case concatenating the
 * tokens' `text` reproduces `text` exactly.
 */
export function tokenizeByTerms(text: string, terms: readonly string[] = []): RomanizedToken[] {
	if (!text) return [];

	const chars = [...text];
	const buckets = prepareTerms(terms);
	return usesInterWordSpaces(text)
		? tokenizeSpaced(chars, buckets)
		: tokenizeSegmented(text, chars, buckets);
}
