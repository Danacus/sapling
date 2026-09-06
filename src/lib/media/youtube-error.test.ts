/**
 * The failure the reader actually shows.
 *
 * Until `onError` was wired, a player that errored left a black rectangle and
 * said nothing; the point of this mapping is that every code becomes a sentence
 * a learner can act on, so what is tested is that none of them falls through to
 * a bare number and that the two codes with one cause say one thing.
 */

import { describe, expect, it } from 'vitest';

import { playerErrorMessage } from './youtube-error';

describe('playerErrorMessage', () => {
	it('names every code YouTube documents', () => {
		expect(playerErrorMessage(2)).toMatch(/did not recognise/i);
		expect(playerErrorMessage(5)).toMatch(/could not play/i);
		expect(playerErrorMessage(100)).toMatch(/no longer on YouTube/i);
		expect(playerErrorMessage(153)).toMatch(/153/);
	});

	it('says the same thing for both embedding-disallowed codes', () => {
		expect(playerErrorMessage(101)).toBe(playerErrorMessage(150));
		expect(playerErrorMessage(101)).toMatch(/owner/i);
	});

	it('still says something for a code nobody has seen', () => {
		expect(playerErrorMessage(999)).toBe('The YouTube player stopped with error 999.');
	});

	it('always answers a whole sentence', () => {
		for (const code of [2, 5, 100, 101, 150, 153, 0, 999]) {
			const message = playerErrorMessage(code);
			expect(message.endsWith('.')).toBe(true);
			expect(message.length).toBeGreaterThan(20);
		}
	});
});
