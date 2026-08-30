/**
 * Word boundaries, for the scripts that do not write any.
 *
 * Chinese, Japanese, Thai and their neighbours run their words together, so
 * "cut this sentence into words" is a dictionary lookup rather than a split on
 * spaces. The app needs that cut in two places — the ruby tokens a romanizer
 * produces (`$lib/romanize/zh`) and the tappable words of a reading text
 * (`$lib/reading/tokenize`) — and both used to fall back to one token per
 * character, which is legible but wrong: 我们 is one word, and a learner tapping
 * 们 alone is tapping half of one.
 *
 * `Intl.Segmenter` is the segmenter, and it is the right one: ICU ships the
 * dictionaries, every current browser and Node 22 have it built in, and it costs
 * nothing to download. It is not perfect — it prefers 自行 + 车 to 自行车 — which
 * is exactly why both callers layer the learner's own vocabulary on top by
 * greedy longest match. A term the learner is studying always wins over the
 * dictionary; the dictionary only decides the spans nobody claimed.
 *
 * Dependency-free and pure, like the rest of `$lib/text`, so both callers can
 * share one answer rather than each inventing a splitter.
 */

import { usesInterWordSpaces } from './script';

/** One segment of a sentence: the text, and whether it is a word at all. */
export interface WordSegment {
	/** Verbatim. Concatenating every segment's `text` reproduces the input. */
	text: string;
	/**
	 * True for word-like segments; false for whitespace, punctuation and symbols
	 * — `Intl.Segmenter`'s own `isWordLike`, which the fallback reproduces.
	 */
	isWord: boolean;
}

/**
 * Segmenters are expensive to construct and cheap to reuse, and a reader runs
 * this over every sentence of every text it opens. Keyed by locale, with `''`
 * standing for the host default.
 */
const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(locale: string | undefined): Intl.Segmenter | undefined {
	if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return undefined;
	const key = locale ?? '';
	const cached = segmenters.get(key);
	if (cached) return cached;
	const made = new Intl.Segmenter(locale, { granularity: 'word' });
	segmenters.set(key, made);
	return made;
}

/** Letters, marks and digits: what a word is made of. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/**
 * What this module did before `Intl.Segmenter`, kept for hosts without it: word
 * runs where the script spaces its words, single characters where it does not,
 * and runs of everything else as non-words.
 *
 * A worse cut, never a wrong render — the concatenation invariant holds either
 * way, so a caller cannot tell the difference structurally.
 */
function fallbackSegments(text: string): WordSegment[] {
	const chars = [...text];
	const out: WordSegment[] = [];
	let i = 0;

	while (i < chars.length) {
		if (!WORD_CHAR.test(chars[i])) {
			let end = i + 1;
			while (end < chars.length && !WORD_CHAR.test(chars[end])) end++;
			out.push({ text: chars.slice(i, end).join(''), isWord: false });
			i = end;
			continue;
		}
		if (!usesInterWordSpaces(chars[i])) {
			out.push({ text: chars[i], isWord: true });
			i++;
			continue;
		}
		let end = i + 1;
		while (end < chars.length && WORD_CHAR.test(chars[end]) && usesInterWordSpaces(chars[end])) {
			end++;
		}
		out.push({ text: chars.slice(i, end).join(''), isWord: true });
		i = end;
	}

	return out;
}

/**
 * Splits `text` into word and non-word segments.
 *
 * `locale` steers ICU's choice of dictionary and should be given when the
 * caller knows it (`'zh'`, `'ja'`, `'th'`); omitted, the host default is used,
 * which still segments CJK correctly because the boundaries come from the
 * characters themselves.
 *
 * The empty string yields an empty array. In every other case concatenating the
 * segments' `text` reproduces the input exactly.
 */
export function segmentWords(text: string, locale?: string): WordSegment[] {
	if (!text) return [];

	const segmenter = segmenterFor(locale);
	if (!segmenter) return fallbackSegments(text);

	const out: WordSegment[] = [];
	for (const segment of segmenter.segment(text)) {
		out.push({ text: segment.segment, isWord: segment.isWordLike === true });
	}
	return out;
}
