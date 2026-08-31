/**
 * The lookup keys, and the one rule that decides whether two cards may coexist.
 *
 * Pure string functions, so the tests are the contract written out: what folds
 * together (case, spacing, Unicode form) and — the part that matters for
 * homographs — what deliberately does not (tone marks).
 */

import { describe, expect, it } from 'vitest';

import { cardKey, readingKey, sameCard, termKey } from './keys';

describe('termKey', () => {
	it('trims, lower-cases and normalizes to NFC', () => {
		expect(termKey('  Café  ')).toBe('café');
		expect(termKey('CAFÉ')).toBe('café');
		// Combining accent vs precomposed: the same word, and the learner cannot
		// tell which they typed. The two are indistinguishable in a source file, so
		// note that the left-hand side here is the decomposed spelling.
		expect(termKey('café')).toBe('café');
		expect(termKey('café')).toBe(termKey('café'));
	});

	it('collapses internal whitespace to single spaces', () => {
		expect(termKey('por   favor')).toBe('por favor');
		expect(termKey(' Por\tFavor ')).toBe('por favor');
	});

	it('does not fold diacritics: ecole is not the same word', () => {
		expect(termKey('ecole')).not.toBe(termKey('école'));
	});

	it('is empty for text made of nothing', () => {
		expect(termKey('   ')).toBe('');
	});
});

describe('readingKey', () => {
	it('strips all whitespace rather than collapsing it', () => {
		expect(readingKey('zì xíng chē')).toBe('zìxíngchē');
		expect(readingKey(' zìxíngchē ')).toBe('zìxíngchē');
		expect(readingKey('zì xíng chē')).toBe(readingKey('zìxíngchē'));
	});

	it('keeps tone marks, which are the whole difference between two readings', () => {
		expect(readingKey('cháng')).not.toBe(readingKey('zhǎng'));
		expect(readingKey('cháng')).not.toBe(readingKey('chang'));
	});

	it('ignores case and Unicode form', () => {
		expect(readingKey('Nǐ Hǎo')).toBe(readingKey('nǐhǎo'));
	});
});

describe('cardKey', () => {
	it('is the bare term when there is no reading', () => {
		expect(cardKey('长')).toBe('长');
		expect(cardKey('长', '')).toBe('长');
		expect(cardKey('长', null)).toBe('长');
	});

	it('tells two readings of one spelling apart', () => {
		expect(cardKey('长', 'cháng')).not.toBe(cardKey('长', 'zhǎng'));
		expect(cardKey('长', 'cháng')).toBe(cardKey(' 长 ', 'CHÁNG'));
	});

	it('does not collide a reading-less card with a read one', () => {
		expect(cardKey('长')).not.toBe(cardKey('长', 'cháng'));
	});
});

describe('sameCard', () => {
	const chang = { term: '长', romanization: 'cháng' };
	const zhang = { term: '长', romanization: 'zhǎng' };
	const bare = { term: '长' };

	it('separates two readings of one spelling', () => {
		expect(sameCard(chang, zhang)).toBe(false);
	});

	it('matches a reading against itself however it was spaced or cased', () => {
		expect(sameCard(chang, { term: ' 长 ', romanization: 'CHÁNG' })).toBe(true);
	});

	it('collides a reading-less card with every spelling of itself, both ways', () => {
		expect(sameCard(bare, chang)).toBe(true);
		expect(sameCard(chang, bare)).toBe(true);
		expect(sameCard(bare, bare)).toBe(true);
	});

	it('says nothing about two different spellings', () => {
		expect(sameCard(chang, { term: '常', romanization: 'cháng' })).toBe(false);
	});
});
