// The event page: the only writer of `storage.local`. It caches the app's term
// list whenever a Sapling tab answers, keeps the inbox, and injects the page
// script when the toolbar button is pressed.

import {
	addToInbox,
	parseInboxEntry,
	parseTermList,
	removeFromInbox,
	type ExtensionRequest,
	type InboxEntry
} from '$lib/extension/protocol';

import { api, INBOX_KEY, send, TERMS_KEY, type CachedTerms, type RuntimeMessage } from './runtime';

const ORIGINS = __SAPLING_ORIGINS__;

function fromApp(url: string | undefined): boolean {
	if (!url) return false;
	try {
		return ORIGINS.includes(new URL(url).origin);
	} catch {
		return false;
	}
}

async function readInbox(): Promise<InboxEntry[]> {
	const stored = (await api.storage.local.get(INBOX_KEY))[INBOX_KEY];
	return Array.isArray(stored) ? stored.flatMap((entry) => parseInboxEntry(entry) ?? []) : [];
}

/** One write at a time, so two quick collects cannot each drop the other's entry. */
let inboxWrites: Promise<unknown> = Promise.resolve();
function updateInbox(change: (inbox: InboxEntry[]) => InboxEntry[]): Promise<InboxEntry[]> {
	const next = inboxWrites.then(async () => {
		const inbox = change(await readInbox());
		await api.storage.local.set({ [INBOX_KEY]: inbox });
		return inbox;
	});
	inboxWrites = next.catch(() => {});
	return next;
}

async function refreshFrom(tabId: number): Promise<boolean> {
	try {
		const list = parseTermList(await send({ type: 'ask-app', request: { kind: 'terms' } }, tabId));
		if (!list) return false;
		await api.storage.local.set({
			[TERMS_KEY]: { ...list, fetchedAt: Date.now() } satisfies CachedTerms
		});
		return true;
	} catch {
		return false;
	}
}

/** The first open Sapling tab that answers refreshes the cache; none leaves it as it was. */
async function refreshTerms(): Promise<void> {
	const tabs = await api.tabs.query({}).catch(() => []);
	for (const tab of tabs) {
		if (tab.id !== undefined && fromApp(tab.url) && (await refreshFrom(tab.id))) return;
	}
}

async function answerApp(request: ExtensionRequest, tabId: number | undefined): Promise<unknown> {
	switch (request.kind) {
		case 'inbox':
			return { entries: await readInbox() };
		case 'remove': {
			const before = (await readInbox()).length;
			const after = await updateInbox((inbox) => removeFromInbox(inbox, request.ids));
			// Added words are in the list now; the next underline should show them.
			if (tabId !== undefined) void refreshFrom(tabId);
			return { removed: before - after.length };
		}
	}
}

async function handle(message: RuntimeMessage, sender: WebExtSender): Promise<unknown> {
	switch (message.type) {
		case 'app-ready':
			if (fromApp(sender.url) && sender.tab?.id !== undefined) await refreshFrom(sender.tab.id);
			return {};
		case 'app-request':
			if (!fromApp(sender.url)) throw new Error('Not a Sapling tab.');
			return answerApp(message.request, sender.tab?.id);
		case 'collect': {
			const entry = parseInboxEntry({ ...message.entry, id: crypto.randomUUID() });
			if (!entry) throw new Error('That word could not be collected.');
			await updateInbox((inbox) => addToInbox(inbox, entry));
			return { collected: entry.id };
		}
		default:
			return undefined;
	}
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (sender.id !== api.runtime.id) return;
	const type = (message as RuntimeMessage | undefined)?.type;
	if (type !== 'app-ready' && type !== 'app-request' && type !== 'collect') return;
	handle(message as RuntimeMessage, sender).then(
		(reply) => sendResponse({ reply }),
		(cause: unknown) => sendResponse({ error: cause instanceof Error ? cause.message : 'failed' })
	);
	return true;
});

api.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	const target = { tabId: tab.id };
	void api.scripting
		.insertCSS({ target, files: ['page.css'] })
		.then(() => api.scripting.executeScript({ target, files: ['page.js'] }))
		.catch((cause: unknown) => console.warn('Sapling: cannot run on this page.', cause));
	void refreshTerms();
});
