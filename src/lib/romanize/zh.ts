/**
 * Mandarin: Hanzi → pinyin, locally, via `pinyin-pro`.
 *
 * The first implementation behind `./index`, and the reason the registry
 * exists. Until now every target-language string carried an LLM-emitted
 * `reading` — one flat romanization per sentence, written by the same call that
 * wrote the sentence. Computing it here instead buys three things the flat
 * string cannot: readings aligned *per token* (so the UI can draw ruby text and
 * hide individual words the learner already knows), immunity to a whole class
 * of wrong or answer-spoiling model readings, and retroactive coverage — old
 * pooled challenges get readings they were never generated with, because
 * nothing about this depends on how the row was written.
 *
 * ## The whole-text invariant
 *
 * **Never romanize a term in isolation.** Mandarin readings resolve from
 * context: 银行 is `yín háng` but 自行车 is `zì xíng chē`; 一 is `yī` alone and
 * `yí` in 一下. `pinyin-pro` does that resolution across the string it is given,
 * so the reading of a word depends on the sentence it sits in. Every reading
 * here therefore comes from the single whole-text `pinyin()` call below and is
 * then *sliced* per character — grouping happens after romanization, never
 * before. Calling `pinyin('行')` to label a token would silently produce the
 * dictionary-default reading and be wrong exactly where a learner most needs it
 * to be right.
 *
 * Traditional characters (`zh-TW`) go through the same path. `pinyin-pro`'s
 * dictionary covers a good deal of Traditional script and falls back to
 * per-character readings otherwise, which is a better outcome than refusing to
 * annotate; the pinyin itself is correct Mandarin either way.
 *
 * This module is dynamically imported by `./index`, so `pinyin-pro` and its
 * dictionary land in their own lazy chunk that only Chinese learners ever
 * download.
 */

import { pinyin } from 'pinyin-pro';

import { segmentWords } from '$lib/text';
import type { RomanizedToken, Romanizer } from './types';

/**
 * The fields we use out of `pinyin-pro`'s `type: 'all'` rows.
 *
 * Declared structurally because the library does not export its `AllData`
 * interface. One row per character, with runs of non-Chinese characters merged
 * into a single row by `nonZh: 'consecutive'`.
 */
interface PinyinEntry {
	/** The source character(s) this row covers, verbatim. */
	readonly origin: string;
	/** The reading, or `''` for a non-Chinese row. */
	readonly pinyin: string;
	/** Whether this row is a Chinese character with a reading. */
	readonly isZh: boolean;
}

/** A term worth matching: Han script only, so Latin or mixed terms are skipped. */
const PURE_HAN = /^\p{Script=Han}+$/u;

/**
 * The learner's terms, prepared for greedy longest-match.
 *
 * Sorted longest first so 中国人 wins over 中国 at the same position, deduped so
 * a repeated term cannot cost a second scan. Re-derived on every call rather
 * than cached against the vocabulary: a challenge is one short sentence and a
 * handful of terms, and a cache keyed on an array identity would be a stale-read
 * waiting to happen the first time a word is added mid-session.
 */
function prepareTerms(terms: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const term of terms) {
		const trimmed = term.trim();
		if (trimmed && PURE_HAN.test(trimmed)) seen.add(trimmed);
	}
	return [...seen].sort((a, b) => b.length - a.length);
}

/**
 * How many entries starting at `start` a vocabulary term covers, or `0`.
 *
 * Compares by *rebuilding* the candidate string from the entries rather than by
 * index arithmetic on `term.length`: a Han character outside the BMP is two
 * UTF-16 units but one entry, so counting units would misalign the span. Terms
 * are already longest-first, hence the first hit wins.
 *
 * A term containing a character `pinyin-pro` does not recognise as Chinese
 * (rare extension-block Hanzi) simply never matches — the walk stops at the
 * non-`isZh` entry — and its characters fall through to the single-character
 * path, which is the right degradation: no reading, but the text survives.
 */
function termSpanAt(
	entries: readonly PinyinEntry[],
	start: number,
	terms: readonly string[]
): number {
	for (const term of terms) {
		let text = '';
		let end = start;
		while (end < entries.length && entries[end].isZh && text.length < term.length) {
			text += entries[end].origin;
			end++;
		}
		if (text === term) return end - start;
	}
	return 0;
}

/**
 * The reading for a span of entries: their pinyin, single-space joined.
 *
 * So 银行 reads `yín háng` — syllable-separated, the form a learner sounds out,
 * and the form that survives being shown above a two-character cell. Entries
 * without a reading contribute nothing; a span with no readings at all reports
 * `null` rather than an empty string, so the caller's "does this token need a
 * ruby slot" test stays a single null check.
 */
function readingOf(entries: readonly PinyinEntry[], start: number, end: number): string | null {
	const parts: string[] = [];
	for (let i = start; i < end; i++) {
		if (entries[i].pinyin) parts.push(entries[i].pinyin);
	}
	return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Where each entry starts in the text, counted in code points, plus a sentinel
 * end.
 *
 * Needed because entry indices and character positions are not the same thing:
 * `nonZh: 'consecutive'` merges a whole Latin run into one entry, so the fifth
 * entry is rarely the fifth character. The segment boundaries below are measured
 * in characters, and this is what maps between the two.
 */
function entryOffsets(entries: readonly PinyinEntry[]): number[] {
	const offsets: number[] = [];
	let pos = 0;
	for (const entry of entries) {
		offsets.push(pos);
		pos += [...entry.origin].length;
	}
	offsets.push(pos);
	return offsets;
}

/**
 * Word boundaries for the spans no vocabulary term claims, from ICU
 * (`segmentWords` in `$lib/text`), as `ends[k]` = where the segment covering
 * character `k` finishes.
 *
 * Without this the fallback is one token per character, which reads as a
 * sentence chopped into syllables: 我们 becomes two cells with two readings and
 * two tap targets for one word. ICU is not always right — it prefers 自行 + 车
 * to 自行车 — but the learner's own terms are matched first and override it
 * wherever they have an opinion, so the dictionary only decides what nobody
 * claimed.
 *
 * The readings are untouched by any of this: they still come from the single
 * whole-text `pinyin()` call and are sliced per span, so context still resolves
 * every polyphone.
 */
function segmentEnds(text: string): number[] {
	const ends: number[] = [];
	let pos = 0;
	for (const segment of segmentWords(text, 'zh')) {
		const length = [...segment.text].length;
		pos += length;
		for (let k = 0; k < length; k++) ends.push(pos);
	}
	return ends;
}

/**
 * Split `text` into display tokens carrying their pinyin.
 *
 * One `pinyin()` call over the whole string (see the module note), then a single
 * left-to-right walk of the resulting per-character entries: at each Chinese
 * character the longest matching vocabulary term claims its span as one token,
 * anything else is grouped by the ICU word boundary it falls in, and each merged
 * run of non-Chinese text — Latin words, digits, punctuation, whitespace, the
 * cloze gap `___` — becomes one token with `reading: null`.
 *
 * The empty string yields an empty array; whitespace-only input yields one
 * null-reading token holding that whitespace. In every case concatenating the
 * tokens' `text` reproduces `text` exactly.
 */
export function tokenizeMandarin(text: string, terms: readonly string[] = []): RomanizedToken[] {
	if (!text) return [];

	const entries: readonly PinyinEntry[] = pinyin(text, { type: 'all', nonZh: 'consecutive' });
	const prepared = prepareTerms(terms);
	const offsets = entryOffsets(entries);
	const ends = segmentEnds(text);

	const tokens: RomanizedToken[] = [];
	let i = 0;
	while (i < entries.length) {
		const entry = entries[i];
		if (!entry.isZh) {
			tokens.push({ text: entry.origin, reading: null });
			i++;
			continue;
		}

		const span = termSpanAt(entries, i, prepared);
		let end: number;
		if (span > 0) {
			end = i + span;
		} else {
			// No term here: run to the end of the ICU word this character sits in.
			const limit = ends[offsets[i]] ?? offsets[i] + 1;
			end = i + 1;
			while (end < entries.length && entries[end].isZh && offsets[end] < limit) end++;
		}

		let word = '';
		for (let j = i; j < end; j++) word += entries[j].origin;
		tokens.push({ text: word, reading: readingOf(entries, i, end) });
		i = end;
	}
	return tokens;
}

/** Mandarin's entry in the `./index` registry. */
export const zhRomanizer: Romanizer = { tokenize: tokenizeMandarin };
