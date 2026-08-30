/**
 * Render-time annotation: what the learner actually sees when a text is opened.
 *
 * A stored text is immutable — the sentences, the readings and the glossary are
 * what the model produced the day it was made. Everything *adaptive* is decided
 * here, on every open, from the vocabulary and the marks as they stand today.
 * That is the whole trick of the mode: a text written last month shows this
 * month's knowledge, because a word's status is not a colour painted onto the
 * text but a fact the app already holds — in the garden with an FSRS strength,
 * marked known, or not yet met.
 *
 * Pure and deterministic in the house style: `now` is passed in, the coin flip
 * is an injectable `rng`, and nothing here reads the clock, the database or a
 * preference store. It does not tokenize either — the caller hands in a
 * `tokenize(text, terms)`, either a local romanizer's (which brings real
 * readings) or `tokenizeByTerms` (which brings none) — so this module never
 * needs to know whether the language has a romanizer.
 *
 * ## Why the caller owns the roll map
 *
 * Under `'adaptive'` a tracked word's reading is a weighted coin flip against
 * its strength (`$lib/session/romanization`). A challenge rolls once at serve
 * time because it is one screen; a text is many sentences and the same word
 * turns up in several of them, and a word that showed its pinyin in sentence
 * two and hid it in sentence five reads as a bug. So the roll is memoised by
 * word key in a `Map` the *caller* holds — one per text open — which is also
 * what makes "re-annotate after the learner added a word" cheap: the map
 * survives, and only the new word rolls.
 */

import { hideReadingProbability } from '$lib/session/romanization';
import { maturityOf } from '$lib/session/progression';
import type { Maturity } from '$lib/session/progression';
import type { RomanizedToken } from '$lib/romanize';
import { wordStrength } from '$lib/srs';
import type { FsrsCardState } from '$lib/srs';
import { isPunctuationOnly } from '$lib/text';
import type { GlossEntry, KnowledgeItem } from '$lib/types';
import type { RomanizationMode } from '$lib/ui/prefs';
import { wordKey } from './tokenize';

/**
 * What the app knows about one word of a text.
 *
 * `'tracked'` — in the garden, with an FSRS card behind it. `'known'` — marked
 * known by the learner, which is a claim about them rather than a schedule.
 * `'new'` — the glossary explains it, so the model expected it to be unfamiliar.
 * `'plain'` — everything else: punctuation and whitespace, and words nobody has
 * said anything about, which are still tappable so the learner can add one.
 */
export type WordStatus = 'tracked' | 'known' | 'new' | 'plain';

/** One rendered word: the text, its reading after the visibility decision, and why. */
export interface ReadingWord {
	/** Verbatim. Concatenating a sentence's words reproduces it exactly. */
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
	/** `tracked` (from the item) or `new` (from the glossary). */
	gloss?: { term: string; meaning: string; reading?: string };
	/**
	 * True when the mode took this word's reading away, as opposed to there never
	 * having been one.
	 *
	 * The two are indistinguishable from `reading: null` alone, and the sentence's
	 * stored reading — the fallback for a language with no local romanizer, where
	 * *no* word has a per-word reading — has to tell them apart to know whether to
	 * render. See {@link showSentenceReading}.
	 */
	readingHidden?: boolean;
}

/** A romanizer's `tokenize`, or `tokenizeByTerms`. */
export type TokenizeFn = (text: string, terms?: readonly string[]) => RomanizedToken[];

/** Everything the decision depends on, gathered once per text open. */
export interface AnnotateContext {
	/** The learner's whole vocabulary — the `tracked` words. */
	items: KnowledgeItem[];
	/** Terms the learner has marked known: understood, but not being scheduled. */
	knownTerms: string[];
	/** The text's own glossary — the `new` words. */
	glossary: GlossEntry[];
	mode: RomanizationMode;
	/** Epoch milliseconds. */
	now: number;
	/**
	 * Per-key adaptive decisions, memoised across the whole text. The caller
	 * creates it (`new Map()`) when the text is opened and keeps it; see the
	 * module note.
	 */
	rolls: Map<string, boolean>;
	/** Injectable `[0,1)` source; defaults to `Math.random`. */
	rng?: () => number;
}

/**
 * The term list handed to the tokenizer: vocabulary, glossary and known terms
 * together.
 *
 * All three, because all three are words the reader should meet as one cell
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
	for (const entry of ctx.glossary) add(entry.term);
	for (const term of ctx.knownTerms) add(term);
	return out;
}

function byKey<T>(rows: readonly T[], term: (row: T) => string): Map<string, T> {
	const map = new Map<string, T>();
	for (const row of rows) {
		const key = wordKey(term(row));
		if (key && !map.has(key)) map.set(key, row);
	}
	return map;
}

/**
 * One weighted coin flip per key, remembered.
 *
 * `>=` rather than `>` at the ends, matching `rollShow` in
 * `$lib/session/romanization`: a probability of 1 hides for every roll in
 * `[0, 1)`, and a probability of 0 shows for all of them.
 */
function showsReading(key: string, item: KnowledgeItem, ctx: AnnotateContext): boolean {
	const cached = ctx.rolls.get(key);
	if (cached !== undefined) return cached;

	const card = item.fsrsCard as FsrsCardState | null | undefined;
	const strength = card ? wordStrength(card, ctx.now) : 0;
	const show = (ctx.rng ?? Math.random)() >= hideReadingProbability(strength);
	ctx.rolls.set(key, show);
	return show;
}

/**
 * Annotates one sentence.
 *
 * The tokenizer is called with {@link termsFor}'s list, so a tracked or glossed
 * word comes back as one token whose text *is* the term — which is what makes
 * every lookup below a map hit rather than a search.
 *
 * Visibility, under the learner's mode: `'on'` keeps every reading the tokenizer
 * produced, `'off'` keeps none. `'adaptive'` is the interesting one — a `known`
 * word never needs the crutch, a `tracked` word fades it out on its own schedule
 * (memoised, see the module note), and `new`/`plain` words keep theirs, because
 * a word the learner has never met is precisely the one that needs it.
 */
export function annotateSentence(
	text: string,
	tokenize: TokenizeFn,
	ctx: AnnotateContext
): ReadingWord[] {
	const tokens = tokenize(text, termsFor(ctx));
	const items = byKey(ctx.items, (item) => item.term);
	const glossary = byKey(ctx.glossary, (entry) => entry.term);
	const known = new Set(ctx.knownTerms.map(wordKey).filter(Boolean));

	return tokens.map((token) => {
		// Whitespace, punctuation, symbols: never a word, so never a key, never a
		// card, and nothing to tap.
		if (isPunctuationOnly(token.text)) {
			return { text: token.text, reading: null, status: 'plain' } satisfies ReadingWord;
		}

		const key = wordKey(token.text);
		const item = items.get(key);
		const entry = glossary.get(key);

		const status: WordStatus = item
			? 'tracked'
			: known.has(key)
				? 'known'
				: entry
					? 'new'
					: 'plain';

		const hidden =
			ctx.mode === 'off'
				? true
				: ctx.mode === 'on'
					? false
					: status === 'known'
						? true
						: status === 'tracked' && item
							? !showsReading(key, item, ctx)
							: false;

		const gloss = item
			? {
					term: item.term,
					meaning: item.meaning,
					...(item.romanization ? { reading: item.romanization } : {})
				}
			: entry
				? {
						term: entry.term,
						meaning: entry.meaning,
						...(entry.reading ? { reading: entry.reading } : {})
					}
				: undefined;

		return {
			text: token.text,
			reading: hidden ? null : token.reading,
			key,
			status,
			...(item ? { itemId: item.id, maturity: maturityOf(item, ctx.now) } : {}),
			...(gloss ? { gloss } : {}),
			...(hidden ? { readingHidden: true } : {})
		} satisfies ReadingWord;
	});
}

/**
 * Whether a sentence's *stored* reading — the flat, sentence-wide string the
 * model wrote — should render under the sentence.
 *
 * It is the fallback for every language without a local romanizer, so the test
 * cannot be "did any word keep a reading": in that case no word ever had one.
 * The question is whether any word still *deserves* one. Under `'adaptive'` that
 * is every word the fading rule did not touch — a new word, an untracked one, a
 * tracked one whose roll came out show — and the line disappears only once the
 * whole sentence is made of words the learner has outgrown.
 */
export function showSentenceReading(words: ReadingWord[], mode: RomanizationMode): boolean {
	if (mode === 'on') return true;
	if (mode === 'off') return false;
	return words.some((word) => word.key !== undefined && !word.readingHidden);
}
