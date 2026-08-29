/**
 * The pairing phrase — the whole of a learner's sync identity.
 *
 * There are no accounts. A store is named by a secret the learner holds: the
 * Worker hashes the phrase to pick the Durable Object, so possessing the phrase
 * *is* the authorisation, and two devices holding the same phrase are two
 * devices on one library. That makes this module the security boundary, and
 * gives it two jobs it must do exactly right:
 *
 * - **Mint enough entropy.** 20 characters over a 32-symbol alphabet is 100
 *   bits. The room name is a hash of it, so a guess is an online guess against
 *   Cloudflare, not an offline one; 100 bits is far past what that needs, and
 *   it costs nothing.
 * - **Normalise identically everywhere.** The phrase is typed by a human on the
 *   second device, so it has to survive case, spacing and the digit/letter
 *   confusions. `worker/index.ts` imports {@link normalizePhrase} from this
 *   very file rather than reimplementing it: two normalisations that disagree
 *   by one character are two different rooms, and the failure looks like an
 *   empty library rather than an error.
 *
 * The alphabet is Crockford base32 — the digits plus the letters that survive
 * being read aloud and retyped, with `I`, `L`, `O` and `U` left out. The first
 * three are folded into the digits they are mistaken for; `U` is simply never
 * minted, so a phrase containing one is a typo and is rejected as invalid.
 */

/** Crockford base32: 10 digits + 22 letters, minus `I`, `L`, `O`, `U`. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Characters in a minted phrase. 20 × 5 bits = 100 bits of entropy. */
export const PHRASE_LENGTH = 20;

/** Characters per dash-separated group in the displayed form. */
const GROUP_SIZE = 5;

/**
 * The canonical form of anything a learner might type or paste.
 *
 * Case, dashes, spaces and any other punctuation are noise: strip them and
 * upper-case what is left. Then fold the three confusable pairs the alphabet
 * deliberately excludes — `I` and `L` read as `1`, `O` reads as `0` — so a
 * phrase copied off another device's screen by eye still lands in the same
 * room. Anything else is left alone to be rejected by {@link isValidPhrase}.
 */
export function normalizePhrase(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, '')
		.replace(/[IL]/g, '1')
		.replace(/O/g, '0');
}

/**
 * Whether a *normalised* phrase is one this app could have minted.
 *
 * Deliberately strict about length. Phrases are always machine-minted, so a
 * wrong length is a transcription error, and catching it here turns a silent
 * failure — pairing into an empty room that looks like lost data — into a
 * message at the input.
 */
export function isValidPhrase(phrase: string): boolean {
	if (phrase.length !== PHRASE_LENGTH) return false;
	return [...phrase].every((char) => ALPHABET.includes(char));
}

/**
 * A fresh pairing phrase, in canonical form.
 *
 * `ALPHABET.length` is 32 and a byte holds 256 values, so `% ALPHABET.length`
 * divides evenly and every symbol is equally likely — the modulo bias that
 * usually makes this pattern wrong does not exist here.
 */
export function mintPhrase(): string {
	const bytes = new Uint8Array(PHRASE_LENGTH);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/**
 * The canonical phrase as a human reads it: `ABCDE-FGHJK-MNPQR-STVWX`.
 *
 * Display only. Everything stored, sent and hashed is the canonical form, so
 * the dashes can never become part of a room's name.
 */
export function formatPhrase(phrase: string): string {
	const groups: string[] = [];
	for (let i = 0; i < phrase.length; i += GROUP_SIZE) {
		groups.push(phrase.slice(i, i + GROUP_SIZE));
	}
	return groups.join('-');
}
