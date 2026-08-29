/**
 * The pairing phrase is the whole of a learner's sync identity, so these tests
 * are about two properties and not much else: a minted phrase is unguessable,
 * and a *typed* phrase reaches the same room as the one it was copied from.
 */
import { describe, expect, it } from 'vitest';

import { formatPhrase, isValidPhrase, mintPhrase, normalizePhrase, PHRASE_LENGTH } from './phrase';

describe('normalizePhrase', () => {
	it('ignores the punctuation the displayed form adds', () => {
		const canonical = mintPhrase();
		expect(normalizePhrase(formatPhrase(canonical))).toBe(canonical);
	});

	it('ignores case, spacing and stray punctuation', () => {
		expect(normalizePhrase('  ab3d5 fg7jk\tm2p4r-stv6x  ')).toBe('AB3D5FG7JKM2P4RSTV6X');
	});

	it('folds the characters the alphabet leaves out onto the digits they look like', () => {
		// `I`, `L` and `O` are never minted precisely because a human reading a
		// phrase off another screen cannot reliably tell them from 1 and 0.
		expect(normalizePhrase('ILO')).toBe('110');
		expect(normalizePhrase('ilo')).toBe('110');
	});

	it('is idempotent, so normalising a stored phrase again is safe', () => {
		const once = normalizePhrase('abcde-fghjk-mnpqr-stvwx');
		expect(normalizePhrase(once)).toBe(once);
	});
});

describe('isValidPhrase', () => {
	it('accepts what mintPhrase produces', () => {
		for (let i = 0; i < 50; i++) expect(isValidPhrase(mintPhrase())).toBe(true);
	});

	it('rejects a phrase of the wrong length', () => {
		const phrase = mintPhrase();
		expect(isValidPhrase(phrase.slice(0, -1))).toBe(false);
		expect(isValidPhrase(phrase + '7')).toBe(false);
	});

	it('rejects letters outside the alphabet', () => {
		// `U` is excluded from Crockford base32 and, unlike I/L/O, is not folded
		// onto anything — so a phrase containing one is a typo, not a variant.
		const withU = 'U'.repeat(PHRASE_LENGTH);
		expect(isValidPhrase(normalizePhrase(withU))).toBe(false);
	});

	it('rejects the un-normalised display form', () => {
		// Callers must normalise first. Asserting this pins the contract that the
		// dashes can never end up as part of a room name.
		expect(isValidPhrase(formatPhrase(mintPhrase()))).toBe(false);
	});
});

describe('mintPhrase', () => {
	it('mints a phrase of the documented length', () => {
		expect(mintPhrase()).toHaveLength(PHRASE_LENGTH);
	});

	it('does not repeat itself', () => {
		// 100 bits: a collision here means the randomness is broken, not unlucky.
		const minted = new Set(Array.from({ length: 200 }, mintPhrase));
		expect(minted.size).toBe(200);
	});

	it('uses the whole alphabet rather than a corner of it', () => {
		// A modulo that biased the mapping, or an alphabet indexed wrongly, would
		// show up as symbols that never appear.
		const seen = new Set([...Array.from({ length: 200 }, mintPhrase).join('')]);
		expect(seen.size).toBe(32);
	});
});

describe('formatPhrase', () => {
	it('groups a minted phrase into readable runs', () => {
		expect(formatPhrase('ABCDEFGHJKMNPQRSTVWX')).toBe('ABCDE-FGHJK-MNPQR-STVWX');
	});
});
