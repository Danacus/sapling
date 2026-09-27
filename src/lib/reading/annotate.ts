/**
 * Render-time annotation: what the learner actually sees when a text is opened.
 *
 * A stored text is immutable, and it is only the text — its segments, as the
 * source cut them. Everything else the reader shows is decided
 * here, on every open, from the vocabulary and the marks as they stand today.
 * That is the whole trick of the mode: a text written last month shows this
 * month's knowledge, because a word's status is not a colour painted onto the
 * text but a fact the app already holds — in the garden with an FSRS strength,
 * marked known, or not yet met.
 *
 * Pure and deterministic in the house style: the coin flip is an injectable
 * `rng`, and nothing here reads the clock, the database or a preference store —
 * a word's strength is derived by the core when the item is read, so the instant
 * it belongs to was chosen before the context was built. It does not tokenize
 * either — the caller hands in a
 * `tokenize(text, terms)`, either a local romanizer's (which brings real
 * readings) or `tokenizeByTerms` (which brings none) — so this module never
 * needs to know whether the language has a romanizer.
 *
 * ## Why the caller owns the roll map
 *
 * Under `'adaptive'` a tracked word's reading is a weighted coin flip against
 * its strength (`$lib/challenges/serve/reading`). A challenge rolls once at serve
 * time because it is one screen; a text is many lines and the same word
 * turns up in several of them, and a word that showed its pinyin in line two
 * and hid it in line five reads as a bug. So the roll is memoised by
 * card key in a `Map` the *caller* holds — one per text open — which is also
 * what makes "re-annotate after the learner added a word" cheap: the map
 * survives, and only the new word rolls.
 *
 * ## Why a spelling is not a word
 *
 * 长 is `cháng` ("long") and `zhǎng` ("to grow"), and a learner may hold both as
 * separate cards with separate schedules. So the item lookup is spelling →
 * *list*, and the token's own reading — which `$lib/romanize` derived
 * from the whole sentence, the one thing that gets polyphones right — decides
 * which of the list this occurrence is. No reading anywhere (a language with no
 * local romanizer, a card written without one) falls back to the first
 * candidate, which is exactly what this module did before.
 */

import { hideReadingProbability } from '$lib/challenges/serve/reading';
import { maturityOf } from '$lib/challenges/serve/progression';
import type { Maturity } from '$lib/challenges/serve/progression';
import type { RomanizedToken } from '$lib/romanize';
import { strengthOf } from '$lib/srs';
import { cardKey, isPunctuationOnly, readingKey } from '$lib/text';
import type { KnowledgeItem } from '$lib/types';
import type { GlossEntry } from '$lib/llm';
import type { RomanizationMode } from '$lib/ui/prefs';
import { wordKey } from './tokenize';

/**
 * What the app knows about one word of a text.
 *
 * `'tracked'` — in the garden, with an FSRS card behind it. `'known'` — marked
 * known by the learner, which is a claim about them rather than a schedule.
 * `'plain'` — everything else: punctuation and whitespace, and words nobody has
 * said anything about, which are still tappable so the learner can look one up
 * or add it.
 */
export type WordStatus = 'tracked' | 'known' | 'plain';

/** One rendered word: the text, its reading after the visibility decision, and why. */
export interface ReadingWord {
	/** Verbatim. Concatenating a line's words reproduces it exactly. */
	text: string;
	/** `null` when there never was one, and when the mode took it away. */
	reading: string | null;
	/** {@link wordKey} of `text`; absent for whitespace and punctuation. */
	key?: string;
	status: WordStatus;
	/** `tracked` only. */
	itemId?: string;
	/** `tracked` only — how far along the word is, for the garden's bed colours. */
	maturity?: Maturity;
	/** `tracked` only — the item's own term, meaning and reading. */
	gloss?: { term: string; meaning: string; reading?: string };
}

/** A romanizer's `tokenize`, or `tokenizeByTerms`. */
export type TokenizeFn = (text: string, terms?: readonly string[]) => RomanizedToken[];

/** Everything the decision depends on, gathered once per text open. */
export interface AnnotateContext {
	/** The learner's whole vocabulary — the `tracked` words. */
	items: KnowledgeItem[];
	/** Terms the learner has marked known: understood, but not being scheduled. */
	knownTerms: string[];
	mode: RomanizationMode;
	/**
	 * Per-card adaptive decisions, memoised across the whole text — keyed by
	 * `cardKey`, so two cards sharing a spelling fade independently. The caller
	 * creates it (`new Map()`) when the text is opened and keeps it; see the
	 * module note.
	 */
	rolls: Map<string, boolean>;
	/** Injectable `[0,1)` source; defaults to `Math.random`. */
	rng?: () => number;
}

/**
 * The term list handed to the tokenizer: vocabulary and known terms together.
 *
 * Both, because both are words the reader should meet as one cell
 * with one card behind it — and in an unspaced script this list is what
 * overrides the dictionary's own split, which does not know that 自行车 is a
 * word the learner is studying. Deduped by key, first spelling wins; the
 * tokenizer matches case-insensitively anyway.
 */
export function termsFor(ctx: AnnotateContext): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const add = (term: string): void => {
		const trimmed = term.trim();
		if (!trimmed) return;
		const key = wordKey(trimmed);
		if (seen.has(key)) return;
		seen.add(key);
		out.push(trimmed);
	};

	for (const item of ctx.items) add(item.term);
	for (const term of ctx.knownTerms) add(term);
	return out;
}

/**
 * Rows grouped by spelling, in the order they were given.
 *
 * A list rather than a first-wins single row, because a spelling no longer
 * identifies a word: 长 is `cháng` ("long") and `zhǎng` ("to grow"), and a
 * learner may be studying both. {@link pickByReading} does the choosing.
 */
function byKey<T>(rows: readonly T[], term: (row: T) => string): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const row of rows) {
		const key = wordKey(term(row));
		if (!key) continue;
		const bucket = map.get(key);
		if (bucket) bucket.push(row);
		else map.set(key, [row]);
	}
	return map;
}

/**
 * Which of several same-spelling rows this token is, decided by the reading the
 * tokenizer derived from the whole sentence.
 *
 * That is the only signal available and it is a good one: `$lib/romanize`
 * romanizes the sentence and slices the result per token precisely so that
 * polyphones come out right, so a 长 read as `zhǎng` in context arrives here
 * carrying `zhǎng`. Compared through `readingKey`, which strips spacing on both
 * sides — a token covering a whole multi-syllable term reads `zì xíng chē`
 * where the card says `zìxíngchē`.
 *
 * Everything else falls back to the first row, which is what the reader did
 * before homographs existed: a language with no local romanizer brings no token
 * readings at all, and a card written without one cannot be told from its
 * sibling anyway.
 */
function pickByReading<T>(
	candidates: readonly T[] | undefined,
	readingOf: (row: T) => string | undefined,
	tokenReading: string | null
): T | undefined {
	if (!candidates?.length) return undefined;
	if (candidates.length === 1) return candidates[0];

	const key = tokenReading ? readingKey(tokenReading) : '';
	if (!key) return candidates[0];

	const match = candidates.find((row) => {
		const reading = readingOf(row);
		return reading ? readingKey(reading) === key : false;
	});
	return match ?? candidates[0];
}

/**
 * One weighted coin flip per card, remembered.
 *
 * Keyed by `cardKey` rather than by the word key the token carries, so the two
 * 长s fade on their own schedules — they are two cards with two strengths, and
 * one roll shared between them would show a reading the other has outgrown.
 *
 * `>=` rather than `>` at the ends, matching `rollShow` in
 * `$lib/challenges/serve/reading`: a probability of 1 hides for every roll in
 * `[0, 1)`, and a probability of 0 shows for all of them.
 */
function showsReading(item: KnowledgeItem, ctx: AnnotateContext): boolean {
	const key = cardKey(item.term, item.romanization);
	const cached = ctx.rolls.get(key);
	if (cached !== undefined) return cached;

	const show = (ctx.rng ?? Math.random)() >= hideReadingProbability(strengthOf(item));
	ctx.rolls.set(key, show);
	return show;
}

/**
 * Annotates one line — a segment, or a sentence of a long one.
 *
 * The tokenizer is called with {@link termsFor}'s list, so a tracked or known
 * word comes back as one token whose text *is* the term — which is what makes
 * every lookup below a map hit rather than a search.
 *
 * Visibility, under the learner's mode: `'on'` keeps every reading the tokenizer
 * produced, `'off'` keeps none. `'adaptive'` is the interesting one — a `known`
 * word never needs the crutch, a `tracked` word fades it out on its own schedule
 * (memoised, see the module note), and `plain` words keep theirs, because
 * a word the learner has never met is precisely the one that needs it.
 */
export function annotateSentence(
	text: string,
	tokenize: TokenizeFn,
	ctx: AnnotateContext
): ReadingWord[] {
	const tokens = tokenize(text, termsFor(ctx));
	const items = byKey(ctx.items, (item) => item.term);
	const known = new Set(ctx.knownTerms.map(wordKey).filter(Boolean));

	return tokens.map((token) => {
		// Whitespace, punctuation, symbols: never a word, so never a key, never a
		// card, and nothing to tap.
		if (isPunctuationOnly(token.text)) {
			return { text: token.text, reading: null, status: 'plain' } satisfies ReadingWord;
		}

		const key = wordKey(token.text);
		const item = pickByReading(items.get(key), (row) => row.romanization, token.reading);

		const status: WordStatus = item ? 'tracked' : known.has(key) ? 'known' : 'plain';

		const hidden =
			ctx.mode === 'off'
				? true
				: ctx.mode === 'on'
					? false
					: status === 'known'
						? true
						: status === 'tracked' && item
							? !showsReading(item, ctx)
							: false;

		const gloss = item
			? {
					term: item.term,
					meaning: item.meaning,
					...(item.romanization ? { reading: item.romanization } : {})
				}
			: undefined;

		return {
			text: token.text,
			reading: hidden ? null : token.reading,
			key,
			status,
			...(item ? { itemId: item.id, maturity: maturityOf(item) } : {}),
			...(gloss ? { gloss } : {})
		} satisfies ReadingWord;
	});
}

/**
 * The looked-up answer for `word`, out of the entries the reader has fetched
 * this open — or `undefined` when nobody has looked it up.
 *
 * A text carries no glossary, so this is the only other place a meaning comes
 * from: the reader's `extraGlossary`, which the card reads when the word itself
 * brings no gloss. Matched by `wordKey`, and between several entries for one
 * spelling by the token's own reading, exactly as a garden item is.
 */
export function lookedUpGloss(
	word: ReadingWord,
	entries: readonly GlossEntry[]
): GlossEntry | undefined {
	if (!word.key) return undefined;
	const candidates = entries.filter((entry) => wordKey(entry.term) === word.key);
	return pickByReading(candidates, (entry) => entry.reading, word.reading);
}
