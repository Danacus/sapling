// Injected into the current tab by the toolbar button (and toggled off by the
// next press). It underlines the learner's words with the CSS Custom Highlight
// API — the page's DOM is never rewritten — and turns a click on any word into
// a small card, in a shadow root, that can collect the word into the inbox.

import { parseInboxEntry, type InboxEntry, type ListedTerm } from '$lib/extension/protocol';
import { tokenizeByTerms } from '$lib/reading/tokenize';
import { loadRomanizer } from '$lib/romanize';
import type { RomanizedToken } from '$lib/romanize/types';
import { termKey } from '$lib/text/keys';

import {
	buildIndex,
	lookUp,
	marksOf,
	MARKS,
	sentenceAround,
	spanAt,
	type Mark,
	type Span,
	type TermIndex
} from './highlight';
import { api, INBOX_KEY, send, TERMS_KEY, type CachedTerms } from './runtime';

type Tokenize = (text: string, terms?: readonly string[]) => RomanizedToken[];

/** Text under these is not prose: code, form fields, editors, scripts. */
const SKIP =
	'script,style,noscript,template,textarea,input,select,option,svg,math,[contenteditable=""],[contenteditable="true"]';
/** A click here belongs to the page. */
const INTERACTIVE =
	'a,button,input,textarea,select,label,summary,[contenteditable],[role="button"]';

const STATUS_LABEL: Record<ListedTerm['status'], string> = {
	new: 'New in your garden',
	learning: 'Learning',
	known: 'Known'
};

interface Running {
	stop(): void;
}

function start(): Running {
	let list: CachedTerms | undefined;
	let inbox: InboxEntry[] = [];
	let index: TermIndex = buildIndex(undefined, []);
	let tokenize: Tokenize = tokenizeByTerms;
	let stopped = false;

	const highlights = Object.fromEntries(MARKS.map((mark) => [mark, new Highlight()])) as Record<
		Mark,
		Highlight
	>;
	for (const mark of MARKS) CSS.highlights.set(`sapling-${mark}`, highlights[mark]);
	const ranges = new Map<Text, { mark: Mark; range: Range }[]>();

	const host = document.createElement('div');
	host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;';
	const shadow = host.attachShadow({ mode: 'closed' });

	function skipped(node: Text): boolean {
		const parent = node.parentElement;
		return !parent || parent.closest(SKIP) !== null || host.contains(node);
	}

	function clear(node: Text): void {
		for (const { mark, range } of ranges.get(node) ?? []) highlights[mark].delete(range);
		ranges.delete(node);
	}

	function scanNode(node: Text): void {
		clear(node);
		if (!node.isConnected || skipped(node) || !/\p{L}/u.test(node.data)) return;
		const marked = marksOf(tokenize(node.data, index.terms), index);
		if (marked.length === 0) return;
		const kept = marked.map(({ start, end, mark }) => {
			const range = new Range();
			range.setStart(node, start);
			range.setEnd(node, end);
			highlights[mark].add(range);
			return { mark, range };
		});
		ranges.set(node, kept);
	}

	function scanTree(root: Node): void {
		if (root.nodeType === Node.TEXT_NODE) return scanNode(root as Text);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) scanNode(node as Text);
	}

	function rescanAll(): void {
		for (const mark of MARKS) highlights[mark].clear();
		ranges.clear();
		if (document.body) scanTree(document.body);
	}

	async function load(): Promise<void> {
		const stored = await api.storage.local.get([TERMS_KEY, INBOX_KEY]);
		list = stored[TERMS_KEY] as CachedTerms | undefined;
		inbox = Array.isArray(stored[INBOX_KEY])
			? (stored[INBOX_KEY] as unknown[]).flatMap((entry) => parseInboxEntry(entry) ?? [])
			: [];
		index = buildIndex(list, inbox);
		const romanizer = await loadRomanizer(list?.language ?? undefined).catch(() => null);
		tokenize = romanizer ? (text, terms) => romanizer.tokenize(text, terms) : tokenizeByTerms;
		if (!stopped) rescanAll();
	}

	// Re-scan only what changed, a beat after the page settles.
	const pending = new Set<Node>();
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			if (host.contains(record.target)) continue;
			if (record.type === 'characterData') pending.add(record.target);
			for (const node of record.addedNodes) pending.add(node);
		}
		if (pending.size === 0 || flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			for (const node of pending) if (node.isConnected) scanTree(node);
			pending.clear();
			for (const node of ranges.keys()) if (!node.isConnected) clear(node);
		}, 250);
	});

	function onStorage(changes: Record<string, WebExtStorageChange>, area: string): void {
		if (area === 'local' && (TERMS_KEY in changes || INBOX_KEY in changes)) void load();
	}

	// --- The card ---------------------------------------------------------

	function closeCard(): void {
		host.remove();
	}

	function el<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		className: string,
		text?: string
	): HTMLElementTagNameMap[K] {
		const node = document.createElement(tag);
		node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function languageOf(node: Node): string {
		return list?.language ?? node.parentElement?.closest('[lang]')?.getAttribute('lang') ?? '';
	}

	function openCard(node: Text, span: Span, sentence: string, at: DOMRect): void {
		shadow.replaceChildren();
		shadow.append(el('style', '', CARD_CSS));
		const card = el('div', 'card');
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-label', 'Sapling');
		const term = span.token.text;
		const listed = lookUp(index, term, span.token.reading);
		const reading = span.token.reading ?? listed?.reading;

		const head = el('div', 'head');
		const word = el('span', 'term', term);
		const lang = languageOf(node);
		if (lang) word.lang = lang;
		head.append(word);
		if (reading) head.append(el('span', 'reading', reading));
		const close = el('button', 'close', '×');
		close.setAttribute('aria-label', 'Close');
		close.addEventListener('click', closeCard);
		head.append(close);
		card.append(head);

		if (listed) {
			if (listed.meaning) card.append(el('p', 'meaning', listed.meaning));
			card.append(el('p', `status status-${listed.status}`, STATUS_LABEL[listed.status]));
		} else if (index.collected.has(termKey(term))) {
			card.append(el('p', 'status', 'In your inbox'));
		} else {
			const collect = el('button', 'collect', 'Collect');
			const note = el('p', 'note');
			collect.addEventListener('click', () => {
				collect.disabled = true;
				send({
					type: 'collect',
					entry: {
						term,
						...(reading ? { reading } : {}),
						sentence,
						pageTitle: document.title,
						url: location.href,
						language: lang,
						collectedAt: Date.now()
					}
				}).then(
					() => {
						collect.remove();
						note.textContent = 'Collected. It waits in the inbox in Sapling.';
					},
					(cause: unknown) => {
						collect.disabled = false;
						note.textContent = cause instanceof Error ? cause.message : 'Could not collect it.';
					}
				);
			});
			card.append(collect, note);
		}

		if (!list || list.terms.length === 0) {
			card.append(
				el(
					'p',
					'note',
					'No word list yet: open Sapling in a tab and the underlines appear here. Collecting works without it.'
				)
			);
		}

		shadow.append(card);
		const left = Math.max(8, Math.min(at.left, window.innerWidth - 300));
		const below = at.bottom + 8;
		host.style.left = `${left}px`;
		host.style.top = below + 180 > window.innerHeight ? '' : `${below}px`;
		host.style.bottom =
			below + 180 > window.innerHeight ? `${window.innerHeight - at.top + 8}px` : '';
		document.documentElement.append(host);
	}

	// --- Clicks -----------------------------------------------------------

	function caretAt(x: number, y: number): { node: Node; offset: number } | undefined {
		if (document.caretPositionFromPoint) {
			const caret = document.caretPositionFromPoint(x, y);
			return caret ? { node: caret.offsetNode, offset: caret.offset } : undefined;
		}
		const range = document.caretRangeFromPoint?.(x, y);
		return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
	}

	/** The caret sits between characters; the clicked one is whichever side's box holds the point. */
	function charAt(node: Text, offset: number, x: number, y: number): number {
		if (offset < node.length) {
			const range = new Range();
			range.setStart(node, offset);
			range.setEnd(node, offset + 1);
			const box = range.getBoundingClientRect();
			if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return offset;
		}
		return Math.max(0, offset - 1);
	}

	/** The block a text node reads in, so a sentence can run across inline markup. */
	function blockOf(node: Node): Element {
		let element = node.parentElement;
		while (element && element !== document.body) {
			if (!getComputedStyle(element).display.startsWith('inline')) return element;
			element = element.parentElement;
		}
		return element ?? document.documentElement;
	}

	function sentenceOf(node: Text, at: number): string {
		const walker = document.createTreeWalker(blockOf(node), NodeFilter.SHOW_TEXT);
		let text = '';
		let offset = 0;
		for (let current = walker.nextNode(); current; current = walker.nextNode()) {
			const piece = current as Text;
			if (piece !== node && skipped(piece)) continue;
			if (piece === node) offset = text.length + at;
			text += piece.data;
		}
		return sentenceAround(text, offset);
	}

	function onClick(event: MouseEvent): void {
		if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		if (event.composedPath().includes(host)) return;
		const target = event.target instanceof Element ? event.target : null;
		const selection = document.getSelection();
		if (target?.closest(INTERACTIVE) || (selection && !selection.isCollapsed)) {
			closeCard();
			return;
		}
		const caret = caretAt(event.clientX, event.clientY);
		if (!caret || caret.node.nodeType !== Node.TEXT_NODE || skipped(caret.node as Text)) {
			closeCard();
			return;
		}
		const node = caret.node as Text;
		const span = spanAt(
			tokenize(node.data, index.terms),
			charAt(node, caret.offset, event.clientX, event.clientY)
		);
		if (!span) {
			closeCard();
			return;
		}
		const range = new Range();
		range.setStart(node, span.start);
		range.setEnd(node, span.end);
		openCard(node, span, sentenceOf(node, span.start), range.getBoundingClientRect());
	}

	function onKey(event: KeyboardEvent): void {
		if (event.key === 'Escape') closeCard();
	}

	document.addEventListener('click', onClick);
	document.addEventListener('keydown', onKey);
	window.addEventListener('scroll', closeCard, { passive: true });
	api.storage.onChanged.addListener(onStorage);
	if (document.body) {
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	}
	void load();

	return {
		stop() {
			stopped = true;
			observer.disconnect();
			if (flushTimer) clearTimeout(flushTimer);
			document.removeEventListener('click', onClick);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('scroll', closeCard);
			api.storage.onChanged.removeListener(onStorage);
			for (const mark of MARKS) CSS.highlights.delete(`sapling-${mark}`);
			closeCard();
		}
	};
}

const CARD_CSS = `
.card {
	--bg: #fbf8f1; --text: #22281f; --muted: #6a6f63; --accent: #3f7a4a; --border: #ddd6c6;
	box-sizing: border-box; width: min(18rem, calc(100vw - 16px)); padding: 0.75rem 0.85rem;
	border: 1px solid var(--border); border-radius: 12px; background: var(--bg); color: var(--text);
	box-shadow: 0 8px 28px rgb(0 0 0 / 0.18);
	font: 15px/1.4 system-ui, sans-serif; text-align: left;
}
@media (prefers-color-scheme: dark) {
	.card { --bg: #1f231d; --text: #ece8dc; --muted: #a3a796; --accent: #8cc492; --border: #3a4036; }
}
.head { display: flex; align-items: baseline; gap: 0.5rem; }
.term { font-size: 1.35rem; font-weight: 700; }
.reading { color: var(--muted); }
.close {
	margin-left: auto; width: 2rem; height: 2rem; border: 0; border-radius: 8px;
	background: transparent; color: var(--muted); font-size: 1.2rem; cursor: pointer;
}
p { margin: 0.4rem 0 0; }
.meaning { font-weight: 600; }
.status, .note { color: var(--muted); font-size: 0.85rem; }
.status-learning { color: #b5832b; }
.status-known { color: var(--accent); }
.collect {
	margin-top: 0.5rem; min-height: 2.25rem; padding: 0 1rem; border: 0; border-radius: 8px;
	background: var(--accent); color: var(--bg); font: inherit; font-weight: 700; cursor: pointer;
}
.collect:disabled { opacity: 0.6; cursor: default; }
`;

const scope = globalThis as { __saplingPage?: Running };
if (scope.__saplingPage) {
	scope.__saplingPage.stop();
	delete scope.__saplingPage;
} else {
	scope.__saplingPage = start();
}
