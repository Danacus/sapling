/**
 * The reading of one vocabulary item, as ruby tokens — the one composition
 * every list of *words* (as opposed to sentences) draws its readings from.
 *
 * An item can carry a reading two ways: the `romanization` stored on it, and
 * whatever the language's local romanizer (`./index`) can compute from the
 * term. **The stored reading is authoritative.** It was written with the
 * word's meaning in view, and for a spelling the learner holds twice — 长 as
 * `cháng` and 长 as `zhǎng` — it is the *only* thing that tells the two cards
 * apart (`knownTermLabels` in `$lib/llm` cites them by it). A local reading of
 * the bare term cannot know which card it is looking at, so it may refine how
 * the stored reading is displayed but never contradict it.
 *
 * "Refine" means: where the local romanizer's reading for the term agrees with
 * the stored one — same syllables once tones, spacing and apostrophes are
 * folded away — the display uses the local tokens, which come one syllable per
 * character and carry proper tone marks, so a two-character word gets its
 * reading over each character rather than one string under the whole term.
 * Where they disagree, the stored reading wins and sits over the whole term.
 * With no stored reading the local one is all there is; with neither there is
 * nothing to draw.
 *
 * Pure, and free of `pinyin-pro`: it only calls whatever `Romanizer` it is
 * handed, so it lives in the registry's own chunk rather than the lazy one.
 */

import { readingKey } from '$lib/text';
import { foldDiacritics } from '$lib/validate';
import type { RomanizedToken, Romanizer } from './types';

/** The two fields of a knowledge item this module reads. */
export interface ReadableItem {
	term: string;
	romanization?: string | null;
}

/**
 * Two spellings of one reading, made comparable: diacritics folded (tones,
 * umlauts), lower-cased, and every space, apostrophe, hyphen and middle dot
 * removed. `Nǐ hǎo`, `ni hao`, `nǐhǎo` and `Ni'hao` all key the same.
 */
export function readingFold(reading: string): string {
	return readingKey(foldDiacritics(reading)).replace(/['’\-·.]/g, '');
}

const HAN = /^\p{Script=Han}+$/u;

/**
 * A grouped Han token split one character per token, when its reading is one
 * syllable per character — else the token unchanged.
 *
 * The romanizer joins per-character readings with single spaces, so the split
 * is a count match: `{银行, yín háng}` becomes `{银, yín}` and `{行, háng}`. A
 * token whose syllable count does not match its character count (a script
 * where one character is not one syllable, or a reading it could not fully
 * give) stays whole rather than being paired up wrongly.
 */
function perCharacter(token: RomanizedToken): RomanizedToken[] {
	if (!token.reading || !HAN.test(token.text)) return [token];
	const chars = [...token.text];
	const syllables = token.reading.split(' ');
	if (chars.length !== syllables.length || chars.length < 2) return [token];
	return chars.map((text, i) => ({ text, reading: syllables[i] }));
}

/**
 * Ruby tokens for `item`'s term, or `null` when there is no reading to show.
 *
 * See the module note for the precedence. The local romanizer is asked for the
 * term with the term as its own vocabulary, so it comes back grouped as one
 * word under the whole-text invariant, and only then split per character.
 */
export function itemReadingTokens(
	item: ReadableItem,
	romanizer: Romanizer | null | undefined
): RomanizedToken[] | null {
	const term = item.term.trim();
	if (!term) return null;
	const stored = item.romanization?.trim() || null;

	const local = romanizer ? romanizer.tokenize(term, [term]).flatMap(perCharacter) : [];
	const localReading = local
		.map((token) => token.reading)
		.filter((reading): reading is string => !!reading)
		.join(' ');

	if (stored) {
		const agree = localReading !== '' && readingFold(localReading) === readingFold(stored);
		return agree ? local : [{ text: term, reading: stored }];
	}
	return localReading === '' ? null : local;
}

/**
 * The readings a local romanizer can give these items *for keeps*: only the
 * ones with no stored reading, and only where the term's reading is
 * context-free (`Romanizer.unambiguousReading`). Keyed by item id; an item the
 * romanizer declines is simply absent, which is the caller's signal that it
 * needs a reader who knows the meaning.
 */
export function localReadings<T extends ReadableItem & { id: string }>(
	items: readonly T[],
	romanizer: Romanizer | null | undefined
): Map<string, string> {
	const out = new Map<string, string>();
	if (!romanizer?.unambiguousReading) return out;
	for (const item of items) {
		if (item.romanization?.trim()) continue;
		const reading = romanizer.unambiguousReading(item.term);
		if (reading) out.set(item.id, reading);
	}
	return out;
}
