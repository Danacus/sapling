/**
 * The browser's transport to YouTube: one hidden sandboxed srcdoc frame,
 * created on first use, that fetches what it is posted and posts the answer
 * back (`youtube-relay-protocol.ts` has why, and the frame's rules). DOM-only.
 *
 * Speaks the wasm build's `request` shape — `{method, url, body?}` as JSON in,
 * `{status, body}` as JSON out — so `captions.ts` hands it to the core as is.
 */

import {
	parseRelayReply,
	RELAY_CHANNEL,
	relayDocument,
	type RelayRequest
} from './youtube-relay-protocol';

interface Waiting {
	resolve: (answer: string) => void;
	reject: (error: Error) => void;
}

const waiting = new Map<number, Waiting>();
let nextId = 0;
let frame: Promise<Window> | undefined;

function relayFrame(): Promise<Window> {
	frame ??= new Promise((resolve, reject) => {
		const iframe = document.createElement('iframe');
		iframe.sandbox.add('allow-scripts');
		iframe.hidden = true;
		iframe.setAttribute('aria-hidden', 'true');
		iframe.srcdoc = relayDocument();
		addEventListener('message', (event) => {
			if (event.source === null || event.source !== iframe.contentWindow) return;
			const reply = parseRelayReply(event.data);
			const pending = reply && waiting.get(reply.id);
			if (!reply || !pending) return;
			waiting.delete(reply.id);
			if ('error' in reply) pending.reject(new Error(reply.error));
			else pending.resolve(JSON.stringify({ status: reply.status, body: reply.body }));
		});
		iframe.addEventListener('load', () => {
			if (iframe.contentWindow) resolve(iframe.contentWindow);
			else reject(new Error('The YouTube relay did not load.'));
		});
		document.body.append(iframe);
	});
	return frame;
}

/** One request through the frame. Rejects when YouTube could not be asked. */
export async function relayRequest(json: string): Promise<string> {
	const { method, url, body } = JSON.parse(json) as Omit<RelayRequest, 'channel' | 'id'>;
	const target = await relayFrame();
	const id = nextId++;
	const request: RelayRequest = { channel: RELAY_CHANNEL, id, method, url, body };
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve, reject });
		// An opaque origin cannot be named as a target.
		target.postMessage(request, '*');
	});
}
