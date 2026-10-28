/**
 * The relay's wire, pure so node can test it: the script the frame runs, and
 * the parent's check of what comes back.
 *
 * YouTube's `player` endpoint answers 403 to any `Origin` but none, its own or
 * `null`. A `sandbox="allow-scripts"` srcdoc frame has an opaque origin, so its
 * requests carry `Origin: null`; a `text/plain` POST with no other header is a
 * simple request, so there is no preflight to fail either. The frame fetches
 * with no credentials and **refuses every URL that is not https on one of
 * YouTube's three hosts** — the parent is the only one who can talk to it, but
 * the frame is what reaches the network, so the rule lives where the fetch is.
 */

/** Tags every message both ways; `message` is shared with every frame. */
export const RELAY_CHANNEL = 'sapling-youtube-relay';

/** What the parent posts to the frame. */
export interface RelayRequest {
	channel: typeof RELAY_CHANNEL;
	id: number;
	method: 'GET' | 'POST';
	url: string;
	body?: string;
}

/** What the frame posts back: an HTTP answer, or why there was none. */
export type RelayReply =
	| { channel: typeof RELAY_CHANNEL; id: number; status: number; body: string }
	| { channel: typeof RELAY_CHANNEL; id: number; error: string };

/**
 * The frame's whole program. A string, not a function's `toString()`, so no
 * bundler can rename or hoist anything out of it; the colocated test
 * runs it against fakes.
 */
export const RELAY_SCRIPT = `
const CHANNEL = ${JSON.stringify(RELAY_CHANNEL)};
const HOSTS = ['www.youtube.com', 'youtube.com', 'm.youtube.com'];
addEventListener('message', async (event) => {
	const data = event.data;
	if (event.source !== parent || !data || data.channel !== CHANNEL) return;
	if (typeof data.id !== 'number') return;
	const id = data.id;
	const reply = (answer) => parent.postMessage({ channel: CHANNEL, id, ...answer }, '*');
	let url;
	try {
		url = new URL(data.url);
	} catch {
		return reply({ error: 'The relay was handed something that is not a URL.' });
	}
	if (url.protocol !== 'https:' || !HOSTS.includes(url.hostname) || url.port || url.username || url.password) {
		return reply({ error: 'The relay only talks to YouTube.' });
	}
	if (data.method !== 'GET' && data.method !== 'POST') {
		return reply({ error: 'The relay only sends GET and POST.' });
	}
	const post = data.method === 'POST';
	try {
		const response = await fetch(url.href, {
			method: data.method,
			credentials: 'omit',
			headers: post ? { 'Content-Type': 'text/plain' } : undefined,
			body: post ? String(data.body ?? '') : undefined
		});
		reply({ status: response.status, body: await response.text() });
	} catch (cause) {
		reply({ error: 'YouTube could not be reached: ' + (cause && cause.message ? cause.message : cause) });
	}
});
`;

/** The frame's document. */
export function relayDocument(): string {
	return `<!doctype html><meta charset="utf-8"><script>${RELAY_SCRIPT}</script>`;
}

/** `data` as a reply to one of ours, or `undefined` for anything else. */
export function parseRelayReply(data: unknown): RelayReply | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const reply = data as Record<string, unknown>;
	if (reply.channel !== RELAY_CHANNEL || typeof reply.id !== 'number') return undefined;
	if (typeof reply.error === 'string') {
		return { channel: RELAY_CHANNEL, id: reply.id, error: reply.error };
	}
	if (typeof reply.status === 'number' && typeof reply.body === 'string') {
		return { channel: RELAY_CHANNEL, id: reply.id, status: reply.status, body: reply.body };
	}
	return undefined;
}
