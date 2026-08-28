/**
 * Word-level diff of what the learner typed against the teacher's rewrite.
 *
 * The model is asked for the *whole* message rewritten rather than a fragment
 * (see `./schemas`), because a fragment cannot be aligned back to a position in
 * the original — and the learner has to see the correction where they made it,
 * not as a sentence quoted underneath. So the alignment is done here, once, and
 * the UI renders spans.
 *
 * Words, not characters: a character diff of an inflected language produces
 * confetti, and "you wrote two words where there is one" is exactly the class of
 * mistake this has to show. Comparison is exact, capitals included — a wrong
 * capital is a real correction in most languages.
 *
 * "Word" is whatever the script delimits, though. Chinese, Japanese and the
 * mainland South-East Asian scripts write without spaces, so a whitespace split
 * hands the aligner one token for the whole sentence and every correction comes
 * out as "you wrote all of this, write all of that" — the one thing the markup
 * exists to avoid. There a character *is* the unit, so those characters
 * tokenize one by one; the same rule then puts the spans back together without
 * inventing spaces the script does not have.
 */

import { foldDiacritics } from '$lib/validate';
import type { Correction } from './schemas';

/** `same` is unchanged text, `removed` came out, `added` went in. */
export type DiffKind = 'same' | 'removed' | 'added';

export interface DiffSpan {
	kind: DiffKind;
	text: string;
}

export interface DiffOptions {
	/**
	 * Compare the way a romanization should be compared: `ni` is `nǐ`, `Ni` is
	 * `ni`, `xi'an` is `xian`.
	 *
	 * Only ever set when the comparison is running against a *reading*, and that
	 * scoping is the whole safety of it. A reading is a transcription aid — its
	 * tone marks and its capitals are not something the learner is being
	 * corrected on, and most of them cannot type the marks at all. An accent in
	 * the target language's own spelling is the exact opposite: in French,
	 * `ecole` for `école` *is* the correction, and folding it would hide the
	 * mistake. Nothing here is applied to a Latin-script target.
	 */
	romanized?: boolean;
}

/**
 * Scripts written without spaces between words, where a character is the unit
 * the learner can be corrected on. Hangul is *not* one of them — Korean spaces
 * its words like a Latin script does.
 */
const UNSPACED =
	'\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}';

/** One unspaced character, or a run of everything else up to the next space. */
const TOKEN = new RegExp(`[${UNSPACED}]|[^\\s${UNSPACED}]+`, 'gu');

/** True of a character that its script writes flush against its neighbour. */
const UNSPACED_CHAR = new RegExp(`[${UNSPACED}]`, 'u');

function tokens(text: string): string[] {
	return text.match(TOKEN) ?? [];
}

/**
 * What goes between two pieces of text that were adjacent in the message: a
 * space, unless either side belongs to a script that writes without them.
 *
 * The UI needs the same answer between two spans that the merge below needs
 * within one, so it is exported rather than duplicated in the template — an
 * inserted 有 must sit flush against 你, and an inserted `wil` must not.
 */
export function spanGap(left: string, right: string): string {
	const before = [...left].pop() ?? '';
	const after = [...right][0] ?? '';
	return UNSPACED_CHAR.test(before) || UNSPACED_CHAR.test(after) ? '' : ' ';
}

/** One romanized word, reduced to what is actually being compared. */
function looseKey(word: string): string {
	return foldDiacritics(word.toLowerCase()).replace(/['’ʼ-]/g, '');
}

/**
 * True when two romanized forms differ only in spacing, case, tone marks or
 * apostrophes — `ni hao ma` against `Nǐ hǎo ma`, `kafei` against `kā fēi`.
 *
 * Segmentation is the reason spacing has to go. Where a syllable boundary falls
 * in pinyin, romaji or revised romanization is a convention the learner has no
 * way to guess and the model applies inconsistently, so two spellings of the
 * same sentence are the same sentence. It is a whole-message test on purpose:
 * within a sentence that *is* wrong, spacing still shifts which words align,
 * and that is a narrower annoyance than being corrected for nothing.
 */
export function sameRomanization(a: string, b: string): boolean {
	return looseKey(a).replace(/\s+/g, '') === looseKey(b).replace(/\s+/g, '');
}

/**
 * Spans in reading order: an unchanged message is one `same` span, a rewritten
 * one is `removed` followed by `added`, and a typical correction alternates.
 *
 * Where a word was both taken out and put in, the removal comes first, so the
 * markup reads as "not this, but this".
 */
export function diffCorrection(
	typed: string,
	corrected: string,
	opts: DiffOptions = {}
): DiffSpan[] {
	const a = tokens(typed);
	const b = tokens(corrected);

	// Words are compared by key and rendered by value, so loosening changes what
	// counts as the same word without changing what the learner reads back.
	const key = (word: string) => (opts.romanized ? looseKey(word) : word);
	const ka = a.map(key);
	const kb = b.map(key);

	// Longest common subsequence, filled from the back so the walk below can go
	// forward and produce spans in reading order.
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0)
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] = ka[i] === kb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const spans: DiffSpan[] = [];
	const push = (kind: DiffKind, word: string) => {
		const last = spans[spans.length - 1];
		if (last && last.kind === kind) last.text += spanGap(last.text, word) + word;
		else spans.push({ kind, text: word });
	};

	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (ka[i] === kb[j]) {
			push('same', a[i]);
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			push('removed', a[i++]);
		} else {
			push('added', b[j++]);
		}
	}
	while (i < a.length) push('removed', a[i++]);
	while (j < b.length) push('added', b[j++]);

	return spans;
}

/** Whether the rewrite changed anything at all — a no-op correction shows nothing. */
export function hasChanges(spans: DiffSpan[]): boolean {
	return spans.some((span) => span.kind !== 'same');
}

/** Letters that are, and are not, Latin — what tells 汉字 from the pinyin for it. */
const LATIN_LETTERS = /\p{Script=Latin}/gu;
const NON_LATIN_LETTERS = /[^\P{L}\p{Script=Latin}]/gu;

function countMatches(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

/**
 * Which side of a correction the learner's message can be aligned against.
 *
 * Normally the corrected text itself. But a learner whose keyboard cannot type
 * the target script writes the *reading* — `ni yao kafe shenme` for 你要什么咖啡
 * — and diffing those two marks every word wrong, which is noise exactly where
 * the markup had one job.
 *
 * Decided by which script the message is mostly in, rather than by whether it
 * is purely one of them: real messages are mixed. Someone typing pinyin will
 * paste in the one character they know, or the word they were just taught, and
 * a single 主理人 in a line of romanization must not throw the whole alignment
 * back onto the script.
 */
export function alignedForm(typed: string, corrected: Correction['corrected']): string {
	const romanized =
		countMatches(typed, LATIN_LETTERS) > countMatches(typed, NON_LATIN_LETTERS) &&
		countMatches(corrected.text, NON_LATIN_LETTERS) > 0;
	return corrected.reading && romanized ? corrected.reading : corrected.text;
}

/** The spans to mark on the learner's bubble, aligned by {@link alignedForm}. */
export function correctionSpans(typed: string, correction: Correction): DiffSpan[] {
	const against = alignedForm(typed, correction.corrected);
	const isReading = against !== correction.corrected.text;
	return diffCorrection(typed, against, { romanized: isReading });
}
