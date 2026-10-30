/**
 * The request-parsing half of the sync backend, which is where a mistake would
 * be quiet: a bearer header that normalises differently from the client's puts
 * two devices in two rooms, and an unclamped `limit` lets a caller ask a Durable
 * Object for its whole log in one response. The Durable Object itself needs
 * workerd and is exercised with `wrangler dev`.
 */
import { describe, expect, it } from 'vitest';

import {
	bearerPhrase,
	isObjectHash,
	MAX_EVENT_OBJECTS,
	MAX_MISSING,
	MAX_OWNER_LENGTH,
	MAX_PULL,
	missingQuery,
	objectHash,
	objectPath,
	pullRange,
	pushedEvents
} from './protocol';

const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'0123456789abcdef'.repeat(4)}`;

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

	describe('object fields', () => {
		const owner = 'text:p1:t1';

		it('carries an owner, its objects and a retirement through', () => {
			const pushed = { ...event, owner, objects: [HASH_A, HASH_B], retire: 'text:p1:t0' };
			expect(pushedEvents({ events: [pushed] })).toEqual([pushed]);
		});

		it('adds no fields to an event from an older client, and reads null as absent', () => {
			for (const raw of [event, { ...event, owner: null, objects: null, retire: null }]) {
				const [parsed] = pushedEvents({ events: [raw] }) ?? [];
				expect(Object.keys(parsed)).toEqual(['id', 'type', 'at', 'device', 'payload']);
			}
		});

		it('accepts an owner with no objects, and a retirement alone', () => {
			expect(pushedEvents({ events: [{ ...event, owner }] })).toEqual([{ ...event, owner }]);
			expect(pushedEvents({ events: [{ ...event, retire: owner }] })).toEqual([
				{ ...event, retire: owner }
			]);
		});

		it('fails the whole page on a malformed field in any event', () => {
			for (const bad of [
				{ owner: '' },
				{ owner: 7 },
				{ owner: 'x'.repeat(MAX_OWNER_LENGTH + 1) },
				{ objects: [HASH_A] },
				{ owner, objects: HASH_A },
				{ owner, objects: ['sha256:nope'] },
				{ owner, objects: Array(MAX_EVENT_OBJECTS + 1).fill(HASH_A) },
				{ retire: '' },
				{ retire: ['text:p1:t1'] }
			]) {
				expect(pushedEvents({ events: [event, { ...event, id: 'e2', ...bad }] })).toBeUndefined();
			}
		});
	});
});

describe('isObjectHash', () => {
	it('accepts sha256: and 64 lowercase hex', () => {
		expect(isObjectHash(HASH_A)).toBe(true);
		expect(isObjectHash(HASH_B)).toBe(true);
	});

	it('refuses every other spelling, so one body has one name', () => {
		for (const value of [
			'a'.repeat(64),
			`SHA256:${'a'.repeat(64)}`,
			`sha256:${'A'.repeat(64)}`,
			`sha256:${'a'.repeat(63)}`,
			`sha256:${'a'.repeat(65)}`,
			`sha256:${'g'.repeat(64)}`,
			`sha512:${'a'.repeat(64)}`,
			` ${HASH_A}`,
			7,
			null
		]) {
			expect(isObjectHash(value)).toBe(false);
		}
	});
});

describe('objectHash', () => {
	it('names bytes by their SHA-256', async () => {
		expect(await objectHash(new Uint8Array())).toBe(
			'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		expect(await objectHash(new TextEncoder().encode('abc'))).toBe(
			'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('is a well-formed name for whatever it hashes', async () => {
		expect(isObjectHash(await objectHash(new TextEncoder().encode('{"segments":[]}')))).toBe(true);
	});
});

describe('objectPath', () => {
	it('reads the hash off an object path', () => {
		expect(objectPath(`/objects/${HASH_A}`)).toEqual({ hash: HASH_A });
	});

	it('marks a malformed name, which answers 400 rather than 404', () => {
		for (const path of ['/objects/nope', `/objects/${HASH_A.toUpperCase()}`]) {
			expect(objectPath(path)).toEqual({ hash: undefined });
		}
	});

	it('is not an object path for the missing route or anything else', () => {
		for (const path of [
			'/objects/missing',
			'/objects/',
			'/objects',
			`/objects/${HASH_A}/x`,
			'/push',
			`/x/objects/${HASH_A}`
		]) {
			expect(objectPath(path)).toBeUndefined();
		}
	});
});

describe('missingQuery', () => {
	it('takes the hashes asked about', () => {
		expect(missingQuery({ hashes: [HASH_A, HASH_B] })).toEqual([HASH_A, HASH_B]);
		expect(missingQuery({ hashes: [] })).toEqual([]);
	});

	it('accepts a full page and refuses one more', () => {
		expect(missingQuery({ hashes: Array(MAX_MISSING).fill(HASH_A) })).toHaveLength(MAX_MISSING);
		expect(missingQuery({ hashes: Array(MAX_MISSING + 1).fill(HASH_A) })).toBeUndefined();
	});

	it('refuses a body that is not a query, or any malformed hash in it', () => {
		for (const body of [null, {}, { hashes: HASH_A }, { hashes: [HASH_A, 'sha256:x'] }]) {
			expect(missingQuery(body)).toBeUndefined();
		}
	});
});
