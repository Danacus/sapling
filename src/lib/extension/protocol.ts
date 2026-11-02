/**
 * The wire between the app and the companion browser extension (`extension/`).
 *
 * The extension never opens the database — it is the app's, in OPFS, behind an
 * exclusive pool — so it talks to an open Sapling tab instead: its bridge
 * content script and the app's `bridge.ts` exchange these messages over
 * `window.postMessage`. Every message is tagged with {@link EXTENSION_PROTOCOL}
 * and addressed `to` one side, because both sides hear every post in the window.
 * Pure, so the parsers that decide what a hostile page can make either side do
 * are tested in node.
 */

import { termKey } from '$lib/text/keys';
import type { KnowledgeItem } from '$lib/types';

/** Bumped, never extended: the two sides ship separately. */
export const EXTENSION_PROTOCOL = 'sapling/extension@1';

export type TermStatus = 'new' | 'learning' | 'known';

/** One word of the learner's list, as the extension underlines it. */
export interface ListedTerm {
	term: string;
	reading?: string;
	meaning?: string;
	status: TermStatus;
}

/** The active target language's list. `language` is the BCP-47 tag, `null` when unresolved. */
export interface TermList {
	language: string | null;
	languageName: string;
	terms: ListedTerm[];
}

/** One word collected on a web page, kept by the extension until the app files it. */
export interface InboxEntry {
	id: string;
	term: string;
	reading?: string;
	sentence: string;
	pageTitle: string;
	url: string;
	language: string;
	collectedAt: number;
}

/** What the extension asks the app. */
export type AppRequest = { kind: 'terms' };

/** What the app asks the extension. */
export type ExtensionRequest = { kind: 'inbox' } | { kind: 'remove'; ids: string[] };

export type Side = 'app' | 'extension';

export type WindowMessage =
	| { protocol: typeof EXTENSION_PROTOCOL; to: 'app'; id: string; request: AppRequest }
	| { protocol: typeof EXTENSION_PROTOCOL; to: 'extension'; id: string; request: ExtensionRequest }
	| { protocol: typeof EXTENSION_PROTOCOL; to: Side; id: string; reply: unknown }
	| { protocol: typeof EXTENSION_PROTOCOL; to: Side; id: string; error: string }
	/** The app has its database open and will answer. */
	| { protocol: typeof EXTENSION_PROTOCOL; to: 'extension'; notice: 'ready' };

/** The garden's words, then the legacy known marks it does not already hold. */
export function listTerms(
	items: readonly KnowledgeItem[],
	knownTerms: readonly string[],
	statusOf: (item: KnowledgeItem) => TermStatus
): ListedTerm[] {
	const held = new Set(items.map((item) => termKey(item.term)));
	return [
		...items.map((item) => ({
			term: item.term,
			status: statusOf(item),
			...(item.romanization ? { reading: item.romanization } : {}),
			...(item.meaning ? { meaning: item.meaning } : {})
		})),
		...knownTerms
			.filter((term) => !held.has(termKey(term)))
			.map((term) => ({ term, status: 'known' as const }))
	];
}

const MAX_IDS = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (value: unknown): value is string => typeof value === 'string';
const optionalString = (value: unknown) => value === undefined || isString(value);

function parseAppRequest(value: unknown): AppRequest | undefined {
	return isRecord(value) && value.kind === 'terms' ? { kind: 'terms' } : undefined;
}

function parseExtensionRequest(value: unknown): ExtensionRequest | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === 'inbox') return { kind: 'inbox' };
	if (
		value.kind === 'remove' &&
		Array.isArray(value.ids) &&
		value.ids.length <= MAX_IDS &&
		value.ids.every(isString)
	) {
		return { kind: 'remove', ids: [...value.ids] };
	}
	return undefined;
}

/** The message in `data` if it is one of ours and well formed, `undefined` otherwise. */
export function parseWindowMessage(data: unknown): WindowMessage | undefined {
	if (!isRecord(data) || data.protocol !== EXTENSION_PROTOCOL) return undefined;
	const to = data.to;
	if (to !== 'app' && to !== 'extension') return undefined;
	if ('notice' in data) {
		return to === 'extension' && data.notice === 'ready'
			? { protocol: EXTENSION_PROTOCOL, to, notice: 'ready' }
			: undefined;
	}
	if (!isString(data.id) || !data.id || data.id.length > 100) return undefined;
	const id = data.id;
	if ('request' in data) {
		if (to === 'app') {
			const request = parseAppRequest(data.request);
			return request && { protocol: EXTENSION_PROTOCOL, to, id, request };
		}
		const request = parseExtensionRequest(data.request);
		return request && { protocol: EXTENSION_PROTOCOL, to, id, request };
	}
	if ('error' in data) {
		return isString(data.error)
			? { protocol: EXTENSION_PROTOCOL, to, id, error: data.error }
			: undefined;
	}
	if ('reply' in data) return { protocol: EXTENSION_PROTOCOL, to, id, reply: data.reply };
	return undefined;
}

const STATUSES: readonly TermStatus[] = ['new', 'learning', 'known'];

function parseListedTerm(value: unknown): ListedTerm | undefined {
	if (!isRecord(value) || !isString(value.term) || !value.term.trim()) return undefined;
	if (!STATUSES.includes(value.status as TermStatus)) return undefined;
	if (!optionalString(value.reading) || !optionalString(value.meaning)) return undefined;
	return {
		term: value.term,
		status: value.status as TermStatus,
		...(value.reading ? { reading: value.reading as string } : {}),
		...(value.meaning ? { meaning: value.meaning as string } : {})
	};
}

/** The app's answer to `terms`; a malformed term is dropped, a malformed list refused. */
export function parseTermList(value: unknown): TermList | undefined {
	if (!isRecord(value) || !Array.isArray(value.terms) || !isString(value.languageName)) {
		return undefined;
	}
	if (value.language !== null && !isString(value.language)) return undefined;
	return {
		language: value.language,
		languageName: value.languageName,
		terms: value.terms.flatMap((term) => parseListedTerm(term) ?? [])
	};
}

/** One stored or collected entry, or `undefined` when any field is off. */
export function parseInboxEntry(value: unknown): InboxEntry | undefined {
	if (!isRecord(value)) return undefined;
	const { id, term, reading, sentence, pageTitle, url, language, collectedAt } = value;
	if (!isString(id) || !id || !isString(term) || !term.trim()) return undefined;
	if (!isString(sentence) || !isString(pageTitle) || !isString(url) || !isString(language)) {
		return undefined;
	}
	if (
		!optionalString(reading) ||
		typeof collectedAt !== 'number' ||
		!Number.isFinite(collectedAt)
	) {
		return undefined;
	}
	return {
		id,
		term,
		...(reading ? { reading } : {}),
		sentence,
		pageTitle,
		url,
		language,
		collectedAt
	};
}

/** The extension's answer to `inbox`; malformed entries are dropped. */
export function parseInbox(value: unknown): InboxEntry[] | undefined {
	if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
	return value.entries.flatMap((entry) => parseInboxEntry(entry) ?? []);
}

/**
 * The inbox with `entry` in it. Collecting the same word on the same page again
 * replaces the old entry rather than listing the word twice.
 */
export function addToInbox(inbox: readonly InboxEntry[], entry: InboxEntry): InboxEntry[] {
	const key = termKey(entry.term);
	const page = pageKey(entry.url);
	return [
		...inbox.filter((old) => !(termKey(old.term) === key && pageKey(old.url) === page)),
		entry
	];
}

export function removeFromInbox(
	inbox: readonly InboxEntry[],
	ids: readonly string[]
): InboxEntry[] {
	const drop = new Set(ids);
	return inbox.filter((entry) => !drop.has(entry.id));
}

/** A page is its URL without the fragment: `#section` links are the same page. */
export function pageKey(url: string): string {
	const hash = url.indexOf('#');
	return hash === -1 ? url : url.slice(0, hash);
}

export interface InboxPage {
	url: string;
	title: string;
	entries: InboxEntry[];
}

/**
 * Entries grouped by the page they were collected on: the most recently visited
 * page first, each page's words in the order they were collected. A page with
 * no title is named by its host.
 */
export function groupInbox(entries: readonly InboxEntry[]): InboxPage[] {
	const pages = new Map<string, InboxPage & { last: number }>();
	for (const entry of [...entries].sort((a, b) => a.collectedAt - b.collectedAt)) {
		const key = pageKey(entry.url);
		const page = pages.get(key);
		if (page) {
			page.entries.push(entry);
			page.last = entry.collectedAt;
			if (entry.pageTitle.trim()) page.title = entry.pageTitle.trim();
		} else {
			pages.set(key, {
				url: key,
				title: entry.pageTitle.trim() || hostOf(key),
				entries: [entry],
				last: entry.collectedAt
			});
		}
	}
	return [...pages.values()]
		.sort((a, b) => b.last - a.last)
		.map(({ url, title, entries }) => ({ url, title, entries }));
}

function hostOf(url: string): string {
	try {
		return new URL(url).host || url;
	} catch {
		return url;
	}
}
