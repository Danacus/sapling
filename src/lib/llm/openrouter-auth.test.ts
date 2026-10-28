import { describe, expect, it } from 'vitest';

import {
	authUrl,
	challengeFor,
	exchangeCode,
	isOpenRouterEndpoint,
	randomToken
} from './openrouter-auth';

function reply(status: number, body: unknown): Promise<Response> {
	return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('randomToken', () => {
	it('is 43 base64url characters and differs per call', () => {
		const a = randomToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(randomToken()).not.toBe(a);
	});
});

describe('challengeFor', () => {
	it('matches the RFC 7636 S256 example', async () => {
		expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
			'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
		);
	});
});

describe('authUrl', () => {
	it('carries the callback and state when given', () => {
		const url = new URL(authUrl('chal', 'https://app.example/openrouter-callback.html', 'st'));
		expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth');
		expect(url.searchParams.get('callback_url')).toBe(
			'https://app.example/openrouter-callback.html'
		);
		expect(url.searchParams.get('code_challenge')).toBe('chal');
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('key_label')).toBe('Sapling');
		expect(url.searchParams.get('state')).toBe('st');
	});

	it('omits the callback for the headless flow', () => {
		const url = new URL(authUrl('chal'));
		expect(url.searchParams.has('callback_url')).toBe(false);
		expect(url.searchParams.has('state')).toBe(false);
		expect(url.searchParams.get('code_challenge')).toBe('chal');
	});
});

describe('isOpenRouterEndpoint', () => {
	it('is true for blank and for OpenRouter, false for anything else', () => {
		expect(isOpenRouterEndpoint(undefined)).toBe(true);
		expect(isOpenRouterEndpoint('  ')).toBe(true);
		expect(isOpenRouterEndpoint('https://openrouter.ai/api/v1/')).toBe(true);
		expect(isOpenRouterEndpoint('http://localhost:11434/v1')).toBe(false);
	});
});

describe('exchangeCode', () => {
	it('posts the code and verifier and returns the key', async () => {
		let seen: { url: string; init?: RequestInit } | undefined;
		const result = await exchangeCode(' abc ', 'ver', (url, init) => {
			seen = { url, init };
			return reply(200, { key: 'sk-or-v1-x' });
		});
		expect(result).toEqual({ ok: true, key: 'sk-or-v1-x' });
		expect(seen?.url).toBe('https://openrouter.ai/api/v1/auth/keys');
		expect(seen?.init?.method).toBe('POST');
		expect(JSON.parse(String(seen?.init?.body))).toEqual({
			code: 'abc',
			code_verifier: 'ver',
			code_challenge_method: 'S256'
		});
	});

	it('reads a 403 as expired', async () => {
		expect(await exchangeCode('c', 'v', () => reply(403, { error: 'nope' }))).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('reads another error, or a reply without a key, as invalid', async () => {
		expect(await exchangeCode('c', 'v', () => reply(400, {}))).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(await exchangeCode('c', 'v', () => reply(200, { key: '' }))).toEqual({
			ok: false,
			reason: 'invalid'
		});
		expect(await exchangeCode('c', 'v', () => Promise.resolve(new Response('not json')))).toEqual({
			ok: false,
			reason: 'invalid'
		});
	});

	it('reads a rejected fetch as network, never throwing', async () => {
		expect(await exchangeCode('c', 'v', () => Promise.reject(new TypeError('offline')))).toEqual({
			ok: false,
			reason: 'network'
		});
	});
});
