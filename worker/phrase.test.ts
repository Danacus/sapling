/**
 * The Worker's phrase rules against the shared fixture — the file
 * `crates/sapling-sync`'s own tests run — and against the client's wasm build
 * itself, so the room a phrase names cannot drift from the phrase a device
 * sends.
 */
import { describe, expect, it } from 'vitest';

import fixture from '../crates/sapling-sync/fixtures/phrases.json';
import {
	isValidPhrase as clientIsValid,
	normalizePhrase as clientNormalize
} from '../src/lib/db/wasm/sapling_core';
import { isValidPhrase, normalizePhrase } from './phrase';

describe('the Worker’s phrase rules', () => {
	it('hold every case of the shared fixture', () => {
		expect(fixture.cases.length).toBeGreaterThan(10);
		for (const { raw, normalized, valid } of fixture.cases) {
			expect(normalizePhrase(raw), raw).toBe(normalized);
			expect(isValidPhrase(normalized), normalized).toBe(valid);
		}
	});

	it('agree with the client’s', () => {
		for (const { raw } of fixture.cases) {
			expect(clientNormalize(raw), raw).toBe(normalizePhrase(raw));
			expect(clientIsValid(normalizePhrase(raw))).toBe(isValidPhrase(normalizePhrase(raw)));
		}
	});
});
