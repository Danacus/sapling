/**
 * The protocol is a list and an interface that must agree, and a dispatcher
 * that must reach the method it names. The type-level check is in
 * `protocol.ts`; these pin the runtime half against the real core.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBackend } from './backend.testing';
import { BACKEND_METHODS, dispatch, isBackendMethod, promised } from './protocol';

describe('protocol', () => {
	it('lists only methods the core answers', async () => {
		const { direct } = await makeTestBackend('devA');
		for (const method of BACKEND_METHODS) expect(typeof direct[method]).toBe('function');
	});

	it('dispatches a request to the named method with its arguments', async () => {
		const { direct } = await makeTestBackend('devA');
		dispatch(direct, { id: 1, method: 'markWord', args: ['  hola ', true] });
		expect(dispatch(direct, { id: 2, method: 'getKnownTerms', args: [] })).toEqual(['hola']);
	});

	it('answers undefined, not null, where the TypeScript signature says so', async () => {
		const { direct } = await makeTestBackend('devA');
		expect(dispatch(direct, { id: 1, method: 'getProfile', args: [] })).toBeUndefined();
		expect(dispatch(direct, { id: 2, method: 'getItem', args: ['missing'] })).toBeUndefined();
		expect(dispatch(direct, { id: 3, method: 'resetData', args: [] })).toBeUndefined();
	});

	it('refuses names that are not methods, so a stray property is never called', () => {
		expect(isBackendMethod('getProfile')).toBe(true);
		expect(isBackendMethod('constructor')).toBe(false);
		expect(isBackendMethod('query')).toBe(false);
	});

	it('turns a throw into a rejection when wrapping the core in-process', async () => {
		const { direct } = await makeTestBackend('devA');
		await expect(promised(direct).importData('not json')).rejects.toThrow('not valid JSON');
	});
});
