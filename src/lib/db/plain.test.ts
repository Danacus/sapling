import { describe, expect, it } from 'vitest';
import { toPlain } from './plain';

describe('toPlain', () => {
	it('passes plain data through unchanged', () => {
		const value = { a: 1, b: ['x', 'y'], c: { nested: true } };
		expect(toPlain(value)).toEqual(value);
	});

	it('strips Proxy-ness from a proxied object so structuredClone accepts it', () => {
		const proxied = new Proxy({ a: 1, b: 'two' }, {});

		// The whole point of the bug: structuredClone (what postMessage uses
		// under the hood) throws DataCloneError on a bare Proxy.
		expect(() => structuredClone(proxied)).toThrow();

		const plain = toPlain(proxied);
		expect(() => structuredClone(plain)).not.toThrow();
		expect(plain).toEqual({ a: 1, b: 'two' });
	});

	it('strips a proxied array nested inside an otherwise-plain object (e.g. Profile.interests)', () => {
		const interests = new Proxy(['travel', 'music'], {});
		const profile = { nativeLanguage: 'English', targetLanguage: 'Spanish', interests };

		expect(() => structuredClone(profile)).toThrow();

		const plain = toPlain(profile);
		expect(() => structuredClone(plain)).not.toThrow();
		expect(plain).toEqual({
			nativeLanguage: 'English',
			targetLanguage: 'Spanish',
			interests: ['travel', 'music']
		});
		expect(Array.isArray(plain.interests)).toBe(true);
	});

	it('drops undefined-valued optional properties rather than keeping them as `undefined`', () => {
		const value: { notes?: string; term: string } = { term: 'hola', notes: undefined };
		const plain = toPlain(value);
		expect('notes' in plain).toBe(false);
		expect(plain).toEqual({ term: 'hola' });
	});

	it('passes undefined through as undefined', () => {
		expect(toPlain(undefined)).toBeUndefined();
	});
});
