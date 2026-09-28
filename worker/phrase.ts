/**
 * The pairing phrase as the Worker reads it: normalise, then validate.
 *
 * The client's phrase logic is Rust (`crates/sapling-sync/src/phrase.rs`); this
 * is the Worker's own copy of the two rules the room depends on, kept here so
 * the Worker ships no wasm. Two normalisations that disagree by one character
 * are two rooms, and the symptom — an empty library on a second device — looks
 * like data loss, so `crates/sapling-sync/fixtures/phrases.json` pins both
 * copies: `phrase.rs`'s tests and `phrase.test.ts` beside this file run the
 * same cases.
 */

/** Crockford base32: 10 digits + 22 letters, minus `I`, `L`, `O`, `U`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters in a minted phrase. */
export const PHRASE_LENGTH = 20;

/** Upper-cased, everything but `0-9A-Z` dropped, `I`/`L` read as `1` and `O` as `0`. */
export function normalizePhrase(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/[IL]/g, '1')
		.replace(/O/g, '0');
}

/** Whether a *normalised* phrase is one the client could have minted. */
export function isValidPhrase(phrase: string): boolean {
	return phrase.length === PHRASE_LENGTH && [...phrase].every((char) => ALPHABET.includes(char));
}
