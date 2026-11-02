/**
 * The app's end of the extension bridge (`protocol.ts`): it answers what the
 * extension asks — the active language's term list, read through the
 * repositories — and asks the extension for its inbox. Installed once, by the
 * root layout, after the database has opened; the window's own messages are the
 * only ones it hears.
 */

import { maturityOf } from '$lib/challenges/serve';
import { getAllItems, getKnownTerms, getProfile } from '$lib/db';
import { targetTagOf } from '$lib/text';
import type { KnowledgeItem } from '$lib/types';

import {
	EXTENSION_PROTOCOL,
	listTerms,
	parseInbox,
	parseWindowMessage,
	type AppRequest,
	type ExtensionRequest,
	type InboxEntry,
	type TermList,
	type TermStatus,
	type WindowMessage
} from './protocol';

/** How long to wait for the extension before deciding it is not installed. */
const REPLY_MS = 1500;

const STATUS_OF: Record<ReturnType<typeof maturityOf>, TermStatus> = {
	new: 'new',
	young: 'learning',
	solid: 'known'
};

const statusOf = (item: KnowledgeItem): TermStatus => STATUS_OF[maturityOf(item)];

async function termList(): Promise<TermList> {
	const [profile, items, known] = await Promise.all([getProfile(), getAllItems(), getKnownTerms()]);
	return {
		language: (profile && targetTagOf(profile)) ?? null,
		languageName: profile?.targetLanguage ?? '',
		terms: listTerms(items, known, statusOf)
	};
}

async function answer(request: AppRequest): Promise<unknown> {
	switch (request.kind) {
		case 'terms':
			return termList();
	}
}

function post(message: WindowMessage): void {
	window.postMessage(message, window.location.origin);
}

/** Only the window's own posts: the bridge content script shares it, nothing else may. */
function ours(event: MessageEvent): WindowMessage | undefined {
	if (event.source !== window || event.origin !== window.location.origin) return undefined;
	return parseWindowMessage(event.data);
}

const waiting = new Map<string, (message: WindowMessage) => void>();
let installed = false;

export function installExtensionBridge(): void {
	if (installed || typeof window === 'undefined') return;
	installed = true;
	window.addEventListener('message', (event) => {
		const message = ours(event);
		if (!message || message.to !== 'app') return;
		if ('request' in message) {
			const { id } = message;
			answer(message.request).then(
				(reply) => post({ protocol: EXTENSION_PROTOCOL, to: 'extension', id, reply }),
				(cause: unknown) =>
					post({
						protocol: EXTENSION_PROTOCOL,
						to: 'extension',
						id,
						error: cause instanceof Error ? cause.message : 'The app could not answer.'
					})
			);
		} else if ('id' in message) {
			waiting.get(message.id)?.(message);
		}
	});
	post({ protocol: EXTENSION_PROTOCOL, to: 'extension', notice: 'ready' });
}

/** The extension's reply, or `undefined` when no extension answered in time. */
function ask(request: ExtensionRequest): Promise<unknown> {
	installExtensionBridge();
	const id = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			waiting.delete(id);
			resolve(undefined);
		}, REPLY_MS);
		waiting.set(id, (message) => {
			clearTimeout(timer);
			waiting.delete(id);
			if ('error' in message) reject(new Error(message.error));
			else if ('reply' in message) resolve(message.reply);
		});
		post({ protocol: EXTENSION_PROTOCOL, to: 'extension', id, request });
	});
}

/** The extension's inbox, or `undefined` when the extension is not installed. */
export async function getExtensionInbox(): Promise<InboxEntry[] | undefined> {
	const reply = await ask({ kind: 'inbox' });
	return reply === undefined ? undefined : (parseInbox(reply) ?? []);
}

/** Drops entries from the inbox; the extension refreshes its term list after. */
export async function removeFromExtensionInbox(ids: string[]): Promise<void> {
	if (ids.length > 0) await ask({ kind: 'remove', ids });
}
