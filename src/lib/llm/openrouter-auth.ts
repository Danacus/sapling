/**
 * OpenRouter's PKCE sign-in, the pure half: a verifier, its S256 challenge, the
 * `/auth` URL and the code-for-key exchange. Where the code comes back from (a
 * callback page or the learner pasting it) is `$lib/ui/OpenRouterConnect`'s
 * business; nothing here stores the key.
 */

import { OPENROUTER_BASE_URL } from './models';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const KEYS_URL = `${OPENROUTER_BASE_URL}/auth/keys`;
const KEY_LABEL = 'Sapling';

/** The static page the browser popup lands on, and the channel it answers over. */
export const CALLBACK_PATH = '/openrouter-callback.html';
export const CALLBACK_CHANNEL = 'sapling-openrouter-auth';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type ExchangeFailure = 'expired' | 'invalid' | 'network';
export type ExchangeResult = { ok: true; key: string } | { ok: false; reason: ExchangeFailure };

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 random bytes as base64url: a PKCE verifier, and a good enough `state`. */
export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

/** Without `callbackUrl` OpenRouter shows the code on screen for pasting. */
export function authUrl(challenge: string, callbackUrl?: string, state?: string): string {
	const url = new URL(OPENROUTER_AUTH_URL);
	if (callbackUrl) url.searchParams.set('callback_url', callbackUrl);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('key_label', KEY_LABEL);
	if (state) url.searchParams.set('state', state);
	return url.toString();
}

/** Blank is OpenRouter; a key from this flow means nothing to any other endpoint. */
export function isOpenRouterEndpoint(baseUrl: string | undefined): boolean {
	const base = baseUrl?.trim().replace(/\/+$/, '');
	return !base || base === OPENROUTER_BASE_URL;
}

/** Codes are single-use and live ten minutes; OpenRouter answers 403 for either. */
export async function exchangeCode(
	code: string,
	verifier: string,
	fetchFn: FetchFn = (url, init) => fetch(url, init)
): Promise<ExchangeResult> {
	let response: Response;
	try {
		response = await fetchFn(KEYS_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				code: code.trim(),
				code_verifier: verifier,
				code_challenge_method: 'S256'
			})
		});
	} catch {
		return { ok: false, reason: 'network' };
	}
	if (response.status === 403) return { ok: false, reason: 'expired' };
	if (!response.ok) return { ok: false, reason: 'invalid' };
	const body = (await response.json().catch(() => undefined)) as { key?: unknown } | undefined;
	const key = typeof body?.key === 'string' ? body.key.trim() : '';
	return key ? { ok: true, key } : { ok: false, reason: 'invalid' };
}

export function exchangeMessage(reason: ExchangeFailure): string {
	switch (reason) {
		case 'expired':
			return 'That code expired or was already used — try again.';
		case 'invalid':
			return 'OpenRouter did not accept that code — try again.';
		case 'network':
			return 'Could not reach OpenRouter — check your connection.';
	}
}
