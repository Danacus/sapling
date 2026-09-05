/**
 * The presentation kit the resolvers are built out of.
 *
 * Everything here answers a question the model was deliberately never asked:
 * where the correct option lands, which readings are safe to show, how a blank
 * is spelled, what counts as the same answer. Splitting it out of
 * `./generate` is what lets `./challenge-types/*` be leaf modules — a wire type
 * imports helpers, never the pipeline that dispatches to it.
 *
 * All of it is pure: no clock, no storage, and every shuffle takes its `[0,1)`
 * source as an argument so a batch can be replayed exactly.
 */

import { usesInterWordSpaces } from '$lib/text';
import type { ClozeChallenge } from '$lib/types';
import { foldDiacritics } from '$lib/validate';
import type { TargetText } from './challenge-types/primitives';

export function undefinedIfBlank(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * `{ key: trimmed }` when the value is a non-blank string, `{}` otherwise — so
 * an optional field is *absent* rather than present-and-undefined. Models emit
 * `null` for "not applicable" far more often than they omit the key, and a
 * Latin-script lesson should carry no romanization keys at all.
 */
export function optionalString<K extends string>(
	key: K,
	value: string | null | undefined
): Partial<Record<K, string>> {
	const trimmed = undefinedIfBlank(value);
	return trimmed ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/** The blank a cloze sentence is built around. */
export const CLOZE_GAP = '___';

/** Case- and whitespace-insensitive key used to detect colliding labels. */
export function labelKey(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Fisher-Yates over a copy; `rng` is injectable so shuffles can be replayed. */
export function shuffled<T>(values: readonly T[], rng: () => number): T[] {
	const out = [...values];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** The trimmed Latin reading of a target-language slot, or `undefined`. */
export function readingOf(value: { reading?: string | null }): string | undefined {
	return undefinedIfBlank(value.reading);
}

/**
 * Trims, drops blanks and removes exact repeats, preserving order. Entry 0 stays
 * the canonical form: the UI speaks and displays it as *the* answer.
 */
export function dedupe(values: (string | null | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Every spelling of one target-language answer the free local validator should
 * accept: the text, its reading, and both with diacritics folded away — so
 * "ni hao" and "el agua esta fria" grade correct without the validator needing
 * script-aware logic of its own. Derived here rather than asked for, which is
 * why the prompt forbids spending tokens on accent variants.
 */
export function answerVariants(target: TargetText): string[] {
	const text = target.text.trim();
	const reading = readingOf(target);
	return dedupe([
		text,
		reading,
		reading ? foldDiacritics(reading) : undefined,
		foldDiacritics(text)
	]);
}

/** One choosable answer, with the reading that belongs to it. */
export interface Choice {
	text: string;
	reading?: string;
	correct?: boolean;
}

/**
 * Lays four choices out in a random order and reports where the right one
 * landed.
 *
 * Position is decided here and never by the model: asked for a `correctIndex`,
 * models answer 0 far more often than chance, and a learner who notices trains
 * "always pick the first one" instead of the language.
 *
 * `optionsRomanization` is all-or-nothing — a column with one gap in it reads
 * worse than no column at all — and is built from the readings that travelled
 * with the options through the same shuffle, so it cannot fall out of step.
 */
export function assembleChoices(choices: Choice[], rng: () => number) {
	const order = shuffled(choices, rng);
	const [a, b, c, d] = order.map((choice) => choice.text);
	const readings = order.map((choice) => choice.reading);
	const correctAt = order.findIndex((choice) => choice.correct);
	return {
		options: [a, b, c, d] as [string, string, string, string],
		correctIndex: correctAt < 0 ? 0 : correctAt,
		...(readings.every((r): r is string => !!r) ? { optionsRomanization: readings } : {})
	};
}

/**
 * True when a slot that must be native-language text is written in the same
 * no-space script as the challenge's own target side — i.e. the model put the
 * target language on both sides of the card, which turns a translation
 * exercise into nonsense. Direction-aware by construction: for a Chinese
 * native speaker learning English the target side is Latin, so their (Chinese)
 * native slots never trip this. Only detectable when the target is a no-space
 * script; a Spanish-vs-English swap has no script signal and stays a prompt
 * problem.
 */
export function nativeSlotInTargetScript(nativeSlot: string, targetText: string): boolean {
	return !usesInterWordSpaces(nativeSlot) && !usesInterWordSpaces(targetText);
}

/** Latin readings are space-separated, so the blank needs air around it. */
const OPENS_WITH_WORD = /^[\p{L}\p{N}]/u;

/**
 * The reading of a cloze sentence, blank included.
 *
 * Built from `before` and `after` only. The answer's reading lives in a field
 * of its own and is never concatenated in, so the line a learner sees before
 * answering structurally cannot spell out the word they are being asked for —
 * there is no guard here to forget. The reading is dropped whenever a visible
 * part lacks one, since a half-romanized sentence is worse than none.
 *
 * Takes the three pieces structurally rather than the `GeneratedCloze` type:
 * this module sits *below* `./challenge-types`, and naming one type's payload
 * here would point an import back up at the def that imports it.
 */
export function clozeSentenceRomanization(generated: {
	before: { text: string; reading?: string | null };
	answer: TargetText;
	after: { text: string; reading?: string | null };
}): Partial<Record<'sentenceRomanization', string>> {
	// No reading on the answer means a Latin-script target: no readings anywhere.
	if (!readingOf(generated.answer)) return {};
	for (const part of [generated.before, generated.after]) {
		if (part.text.trim() && !readingOf(part)) return {};
	}
	const head = readingOf(generated.before) ?? '';
	const tail = readingOf(generated.after) ?? '';
	if (!head && !tail) return {};
	const gapTail = OPENS_WITH_WORD.test(tail) ? ' ' : '';
	const line = `${head}${head ? ' ' : ''}${CLOZE_GAP}${gapTail}${tail}`.replace(/\s+/g, ' ').trim();
	return { sentenceRomanization: line };
}

/**
 * The tappable candidate words for a cloze, shuffled with the answer among
 * them.
 *
 * Distractors that collide with the answer (or with each other) are dropped:
 * two identical chips make one of them wrong by position alone. The answer
 * itself never is. A bank of fewer than two chips is not a choice, so the
 * challenge falls back to typing.
 *
 * `limit` is the bank size the challenge was *planned* at, answer included —
 * how much support a word at that rung should get. Surplus distractors are cut
 * before the shuffle, never after, so which chip the answer lands on stays a
 * question only `rng` answers.
 */
export function clozeWordBank(
	answer: TargetText,
	distractors: TargetText[] | null | undefined,
	rng: () => number,
	limit?: number
): Partial<Pick<ClozeChallenge, 'wordBank' | 'wordBankRomanization'>> {
	if (!distractors?.length) return {};
	const answerChoice: Choice = { text: answer.text.trim(), reading: readingOf(answer) };
	const seen = new Set([labelKey(answerChoice.text)]);
	const allowance = limit === undefined ? Infinity : Math.max(0, limit - 1);
	const kept: Choice[] = [];
	for (const distractor of distractors) {
		if (kept.length >= allowance) break;
		const text = distractor.text.trim();
		const key = labelKey(text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		kept.push({ text, reading: readingOf(distractor) });
	}
	const entries = shuffled([answerChoice, ...kept], rng);
	if (entries.length < 2) return {};

	const readings = entries.map((entry) => entry.reading);
	return {
		wordBank: entries.map((entry) => entry.text),
		...(readings.every((r): r is string => !!r) ? { wordBankRomanization: readings } : {})
	};
}

/**
 * Ceiling on the extra wrong tiles a `word-order` challenge may carry.
 *
 * A tray with twice as many tiles as the sentence needs stops being a word-order
 * exercise and becomes a search. An oversized list is cosmetic, so the resolver
 * trims it rather than dropping a challenge we already paid for.
 */
export const MAX_WORD_ORDER_DISTRACTORS = 3;

/**
 * Ceiling on the whole tray (sentence tiles + distractors). The prompt asks for
 * 4-8 sentence tiles but models overshoot; when they do, the distractor
 * allowance shrinks first — the sentence itself is the content we paid for and
 * cannot be trimmed, but nothing obliges us to pad an oversized one further.
 */
export const MAX_WORD_ORDER_TILES = 10;

/** One segmented word: its text and the reading that travels with it. */
export interface Token {
	text: string;
	reading?: string;
}

/** Trims a `TargetText` list into tokens; `undefined` when any of them is blank. */
export function tokenize(words: TargetText[]): Token[] | undefined {
	const tokens = words.map((word) => ({ text: word.text.trim(), reading: readingOf(word) }));
	return tokens.every((token) => token.text) ? tokens : undefined;
}

/**
 * `{ key: readings }` when *every* token has one, `{}` otherwise.
 *
 * All-or-nothing for the same reason as `optionsRomanization`: a row of tiles
 * where three are annotated and one is not reads worse than a bare row, and the
 * gap looks like a bug rather than a missing reading.
 */
export function tokenReadings<K extends string>(
	key: K,
	tokens: Token[]
): Partial<Record<K, string[]>> {
	const readings = tokens.map((token) => token.reading);
	return readings.every((reading): reading is string => !!reading)
		? ({ [key]: readings } as Record<K, string[]>)
		: {};
}
