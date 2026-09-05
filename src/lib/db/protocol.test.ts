/**
 * The protocol is a list and an interface that must agree, and a dispatcher
 * that must reach the method it names. The type-level check is in
 * `protocol.ts`; these pin the runtime half against the real core.
 */
import { describe, expect, it } from 'vitest';

import { makeTestBackend } from './backend.testing';
import { BACKEND_METHODS, dispatch, isBackendMethod, promised } from './protocol';

describe('protocol', () => {
	it('lists only methods the core implements', async () => {
		const { core } = await makeTestBackend('devA');
		for (const method of BACKEND_METHODS) expect(typeof core[method]).toBe('function');
	});

	it('dispatches a request to the named method with its arguments', async () => {
		const { core } = await makeTestBackend('devA');
		dispatch(core, { id: 1, method: 'markWord', args: ['  hola ', true] });
		expect(dispatch(core, { id: 2, method: 'getKnownTerms', args: [] })).toEqual(['hola']);
	});

	it('refuses names that are not methods, so a stray property is never called', () => {
		expect(isBackendMethod('getProfile')).toBe(true);
		expect(isBackendMethod('constructor')).toBe(false);
		expect(isBackendMethod('query')).toBe(false);
	});

	it('turns a throw into a rejection when wrapping the core in-process', async () => {
		const { core } = await makeTestBackend('devA');
		await expect(promised(core).importData('not json')).rejects.toThrow('not valid JSON');
	});
});
