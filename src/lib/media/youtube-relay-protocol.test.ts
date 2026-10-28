import { describe, expect, it, vi } from 'vitest';

import {
	parseRelayReply,
	RELAY_CHANNEL,
	RELAY_SCRIPT,
	relayDocument
} from './youtube-relay-protocol';

type Listener = (event: { source: unknown; data: unknown }) => Promise<void>;

/** Runs the frame's script against a fake parent and a fake `fetch`. */
function frame(answer: () => Promise<Response> = async () => new Response('ok', { status: 200 })) {
	let listener: Listener | undefined;
	const parent = { postMessage: vi.fn() };
	const fetch = vi.fn((_url: string, _init: RequestInit) => answer());
	new Function('addEventListener', 'parent', 'fetch', RELAY_SCRIPT)(
		(_: string, fn: Listener) => (listener = fn),
		parent,
		fetch
	);
	return {
		fetch,
		async post(data: unknown, source: unknown = parent) {
			await listener!({ source, data });
			return parent.postMessage.mock.calls.at(-1);
		}
	};
}

function request(url: string, extra: Record<string, unknown> = {}) {
	return { channel: RELAY_CHANNEL, id: 7, method: 'GET', url, ...extra };
}

describe('the relay frame', () => {
	it('fetches a YouTube URL without credentials and posts the answer back', async () => {
		const relay = frame();
		const reply = await relay.post(request('https://www.youtube.com/api/timedtext?v=x'));
		expect(reply).toEqual([{ channel: RELAY_CHANNEL, id: 7, status: 200, body: 'ok' }, '*']);
		expect(relay.fetch).toHaveBeenCalledWith('https://www.youtube.com/api/timedtext?v=x', {
			method: 'GET',
			credentials: 'omit',
			headers: undefined,
			body: undefined
		});
	});

	it('posts its body as text/plain and sets no other header', async () => {
		const relay = frame();
		await relay.post(
			request('https://youtube.com/youtubei/v1/player', { method: 'POST', body: '{}' })
		);
		expect(relay.fetch.mock.calls[0]![1]).toMatchObject({
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: '{}'
		});
	});

	it.each([
		'http://www.youtube.com/api/timedtext',
		'https://youtube.com.example.net/',
		'https://example.com/?u=https://www.youtube.com/',
		'https://www.youtube.com:8443/',
		'https://user@www.youtube.com/',
		'https://music.youtube.com/',
		'not a url'
	])('refuses %s without fetching it', async (url) => {
		const relay = frame();
		const [reply] = (await relay.post(request(url)))!;
		expect(reply).toMatchObject({ channel: RELAY_CHANNEL, id: 7 });
		expect(reply.error).toBeTypeOf('string');
		expect(relay.fetch).not.toHaveBeenCalled();
	});

	it('refuses a method it does not relay', async () => {
		const relay = frame();
		const [reply] = (await relay.post(request('https://m.youtube.com/', { method: 'PUT' })))!;
		expect(reply.error).toBeTypeOf('string');
		expect(relay.fetch).not.toHaveBeenCalled();
	});

	it('ignores anyone but its parent, and messages that are not its own', async () => {
		const relay = frame();
		expect(await relay.post(request('https://www.youtube.com/'), {})).toBeUndefined();
		expect(await relay.post({ ...request('https://www.youtube.com/'), channel: 'x' })).toBe(
			undefined
		);
		expect(relay.fetch).not.toHaveBeenCalled();
	});

	it('turns a failed fetch into an error reply', async () => {
		const relay = frame(() => Promise.reject(new TypeError('NetworkError')));
		const [reply] = (await relay.post(request('https://www.youtube.com/')))!;
		expect(reply.error).toContain('NetworkError');
	});

	it('is the only script in the document', () => {
		expect(relayDocument()).toContain(`<script>${RELAY_SCRIPT}</script>`);
	});
});

describe('parseRelayReply', () => {
	it('reads an answer and an error', () => {
		expect(parseRelayReply({ channel: RELAY_CHANNEL, id: 1, status: 403, body: '' })).toEqual({
			channel: RELAY_CHANNEL,
			id: 1,
			status: 403,
			body: ''
		});
		expect(parseRelayReply({ channel: RELAY_CHANNEL, id: 2, error: 'no' })).toEqual({
			channel: RELAY_CHANNEL,
			id: 2,
			error: 'no'
		});
	});

	it('ignores anything else', () => {
		expect(parseRelayReply(null)).toBeUndefined();
		expect(parseRelayReply('hi')).toBeUndefined();
		expect(parseRelayReply({ channel: 'other', id: 1, status: 200, body: '' })).toBeUndefined();
		expect(parseRelayReply({ channel: RELAY_CHANNEL, status: 200, body: '' })).toBeUndefined();
		expect(parseRelayReply({ channel: RELAY_CHANNEL, id: 1, status: '200' })).toBeUndefined();
	});
});
