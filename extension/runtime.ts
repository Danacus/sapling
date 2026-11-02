// The extension's own messages between its scripts, and what it keeps in
// `storage.local`. The app never sees these; it speaks `$lib/extension/protocol`.

import type { AppRequest, ExtensionRequest, InboxEntry, TermList } from '$lib/extension/protocol';

/** Firefox's promise-based `browser`, else Chrome's `chrome`, which promises too in MV3. */
export const api: WebExtApi = (globalThis.browser ?? globalThis.chrome) as WebExtApi;

export type RuntimeMessage =
	/** Bridge → background: the app in this tab has its database open. */
	| { type: 'app-ready' }
	/** Bridge → background: the app asks the extension something. */
	| { type: 'app-request'; request: ExtensionRequest }
	/** Background → bridge: ask the app in this tab. */
	| { type: 'ask-app'; request: AppRequest }
	/** Page script → background: keep this word. */
	| { type: 'collect'; entry: Omit<InboxEntry, 'id'> };

/** Every runtime answer is one of these, so a failure crosses as a value. */
export type RuntimeAnswer = { reply: unknown } | { error: string };

/** Send and unwrap: the reply, or a rejection carrying the other side's error. */
export async function send(message: RuntimeMessage, tabId?: number): Promise<unknown> {
	const answer = (await (tabId === undefined
		? api.runtime.sendMessage(message)
		: api.tabs.sendMessage(tabId, message))) as
		Partial<{ reply: unknown; error: string }> | undefined;
	if (!answer) throw new Error('Nothing answered.');
	if (typeof answer.error === 'string') throw new Error(answer.error);
	return answer.reply;
}

export interface CachedTerms extends TermList {
	fetchedAt: number;
}

export const TERMS_KEY = 'terms';
export const INBOX_KEY = 'inbox';
