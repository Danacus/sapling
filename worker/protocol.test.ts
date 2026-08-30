/**
 * The request-parsing half of the sync backend, which is where a mistake would
 * be quiet: a bearer header that normalises differently from the client's puts
 * two devices in two rooms, and an unclamped `limit` lets a caller ask a Durable
 * Object for its whole log in one response. The Durable Object itself needs
 * workerd and is exercised with `wrangler dev`.
 */
import { describe, expect, it } from 'vitest';

import { bearerPhrase, MAX_PULL, pullRange, pushedEvents } from './protocol';

const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';

describe('bearerPhrase', () => {
	it('accepts the phrase in every form a learner might have typed it', () => {
		for (const presented of [PHRASE, 'ABCDE-FGHJK-MNPQR-STVWX', ' abcde fghjk mnpqr stvwx ']) {
			expect(bearerPhrase(`Bearer ${presented}`)).toBe(PHRASE);
		}
	});

	it('is not fussy about the scheme keyword itself', () => {
		expect(bearerPhrase(`bearer ${PHRASE}`)).toBe(PHRASE);
	});

	it('refuses a missing, schemeless or malformed phrase', () => {
		for (const header of [null, '', PHRASE, 'Bearer ', 'Bearer hello', `Basic ${PHRASE}`]) {
			expect(bearerPhrase(header)).toBeUndefined();
		}
	});
});

describe('pullRange', () => {
	it('defaults to the whole log from the start', () => {
		expect(pullRange(new URL('https://sync.test/pull'))).toEqual({ after: 0, limit: MAX_PULL });
	});

	it('reads what the client asked for', () => {
		expect(pullRange(new URL('https://sync.test/pull?after=12&limit=50'))).toEqual({
			after: 12,
			limit: 50
		});
	});

	it('caps the page size however large the ask', () => {
		expect(pullRange(new URL('https://sync.test/pull?limit=100000')).limit).toBe(MAX_PULL);
	});

	it('keeps limit=0, which is how the connection probe asks for nothing', () => {
		expect(pullRange(new URL('https://sync.test/pull?after=0&limit=0')).limit).toBe(0);
	});

	it('falls back rather than trusting junk', () => {
		expect(pullRange(new URL('https://sync.test/pull?after=nope&limit=-5'))).toEqual({
			after: 0,
			limit: 0
		});
	});
});

describe('pushedEvents', () => {
	const event = { id: 'e1', type: 'itemAdded', at: 1, device: 'devA', payload: { id: 'i1' } };

	it('takes the envelope and leaves the payload alone', () => {
		expect(pushedEvents({ events: [event] })).toEqual([event]);
	});

	it('accepts an empty push', () => {
		expect(pushedEvents({ events: [] })).toEqual([]);
	});

	it('refuses a body that is not a push, or an envelope missing a field', () => {
		for (const body of [
			null,
			{},
			{ events: 'nope' },
			{ events: [null] },
			{ events: [{ ...event, id: '' }] },
			{ events: [{ ...event, at: 'now' }] }
		]) {
			expect(pushedEvents(body)).toBeUndefined();
		}
	});
});
