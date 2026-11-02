// The content script on Sapling's own origin: it relays between the background
// (`runtime` messages) and the app (`window.postMessage`), since Firefox has no
// `externally_connectable`. It never touches the database; the app answers.

import {
	EXTENSION_PROTOCOL,
	parseWindowMessage,
	type AppRequest,
	type WindowMessage
} from '$lib/extension/protocol';

import { api, send, type RuntimeMessage } from './runtime';

const REPLY_MS = 5000;
const waiting = new Map<string, (message: WindowMessage) => void>();

function post(message: WindowMessage): void {
	window.postMessage(message, window.location.origin);
}

// The manifest matches by host (Firefox ignores ports there), so another localhost app gets this script too.
const isApp = __SAPLING_ORIGINS__.includes(window.location.origin);

window.addEventListener('message', (event) => {
	if (!isApp || event.source !== window || event.origin !== window.location.origin) return;
	const message = parseWindowMessage(event.data);
	if (!message || message.to !== 'extension') return;

	if ('notice' in message) {
		void send({ type: 'app-ready' }).catch(() => {});
	} else if ('request' in message) {
		const { id, request } = message;
		send({ type: 'app-request', request }).then(
			(reply) => post({ protocol: EXTENSION_PROTOCOL, to: 'app', id, reply }),
			(cause: unknown) =>
				post({
					protocol: EXTENSION_PROTOCOL,
					to: 'app',
					id,
					error: cause instanceof Error ? cause.message : 'The extension could not answer.'
				})
		);
	} else {
		waiting.get(message.id)?.(message);
	}
});

/** Ask the app in this tab; rejects when it does not answer (no profile yet, another tab holds the database). */
function askApp(request: AppRequest): Promise<unknown> {
	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			waiting.delete(id);
			reject(new Error('Sapling did not answer.'));
		}, REPLY_MS);
		waiting.set(id, (message) => {
			clearTimeout(timer);
			waiting.delete(id);
			if ('error' in message) reject(new Error(message.error));
			else if ('reply' in message) resolve(message.reply);
		});
		post({ protocol: EXTENSION_PROTOCOL, to: 'app', id, request });
	});
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	const ask = message as RuntimeMessage;
	if (!isApp || ask?.type !== 'ask-app') return;
	askApp(ask.request).then(
		(reply) => sendResponse({ reply }),
		(cause: unknown) => sendResponse({ error: cause instanceof Error ? cause.message : 'failed' })
	);
	return true;
});
