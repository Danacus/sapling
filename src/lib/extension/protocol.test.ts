import { describe, expect, it } from 'vitest';

import type { KnowledgeItem } from '$lib/types';

import {
	addToInbox,
	EXTENSION_PROTOCOL,
	groupInbox,
	listTerms,
	pageKey,
	parseInbox,
	parseInboxEntry,
	parseTermList,
	parseWindowMessage,
	removeFromInbox,
	type InboxEntry
} from './protocol';

const P = EXTENSION_PROTOCOL;

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
	return {
		id: 'e1',
		term: 'gato',
		sentence: 'El gato duerme.',
		pageTitle: 'Gatos',
		url: 'https://example.org/gatos',
		language: 'es',
		collectedAt: 1000,
		...overrides
	};
}

describe('parseWindowMessage', () => {
	it('accepts the requests each side answers', () => {
		expect(
			parseWindowMessage({ protocol: P, to: 'app', id: 'a', request: { kind: 'terms' } })
		).toEqual({ protocol: P, to: 'app', id: 'a', request: { kind: 'terms' } });
		expect(
			parseWindowMessage({ protocol: P, to: 'extension', id: 'b', request: { kind: 'inbox' } })
		).toEqual({ protocol: P, to: 'extension', id: 'b', request: { kind: 'inbox' } });
		expect(
			parseWindowMessage({
				protocol: P,
				to: 'extension',
				id: 'c',
				request: { kind: 'remove', ids: ['x', 'y'] }
			})
		).toEqual({
			protocol: P,
			to: 'extension',
			id: 'c',
			request: { kind: 'remove', ids: ['x', 'y'] }
		});
	});

	it('refuses a request addressed to the side that does not answer it', () => {
		expect(
			parseWindowMessage({ protocol: P, to: 'extension', id: 'a', request: { kind: 'terms' } })
		).toBeUndefined();
		expect(
			parseWindowMessage({ protocol: P, to: 'app', id: 'a', request: { kind: 'inbox' } })
		).toBeUndefined();
	});

	it('accepts replies, errors and the ready notice', () => {
		expect(parseWindowMessage({ protocol: P, to: 'app', id: 'a', reply: { entries: [] } })).toEqual(
			{
				protocol: P,
				to: 'app',
				id: 'a',
				reply: { entries: [] }
			}
		);
		expect(parseWindowMessage({ protocol: P, to: 'app', id: 'a', error: 'no' })).toEqual({
			protocol: P,
			to: 'app',
			id: 'a',
			error: 'no'
		});
		expect(parseWindowMessage({ protocol: P, to: 'extension', notice: 'ready' })).toEqual({
			protocol: P,
			to: 'extension',
			notice: 'ready'
		});
	});

	it('ignores everything else', () => {
		for (const data of [
			null,
			'terms',
			[],
			{ to: 'app', id: 'a', request: { kind: 'terms' } },
			{ protocol: 'sapling/extension@0', to: 'app', id: 'a', request: { kind: 'terms' } },
			{ protocol: P, to: 'tab', id: 'a', request: { kind: 'terms' } },
			{ protocol: P, to: 'app', request: { kind: 'terms' } },
			{ protocol: P, to: 'app', id: '', request: { kind: 'terms' } },
			{ protocol: P, to: 'app', id: 'x'.repeat(101), request: { kind: 'terms' } },
			{ protocol: P, to: 'app', id: 'a', request: { kind: 'delete' } },
			{ protocol: P, to: 'extension', id: 'a', request: { kind: 'remove', ids: [1] } },
			{ protocol: P, to: 'extension', id: 'a', request: { kind: 'remove', ids: 'x' } },
			{ protocol: P, to: 'app', id: 'a', error: 42 },
			{ protocol: P, to: 'app', notice: 'ready' },
			{ protocol: P, to: 'extension', notice: 'gone' },
			{ protocol: P, to: 'app', id: 'a' }
		]) {
			expect(parseWindowMessage(data)).toBeUndefined();
		}
	});
});

describe('parseTermList', () => {
	it('keeps good terms and drops malformed ones', () => {
		expect(
			parseTermList({
				language: 'zh-CN',
				languageName: 'Chinese',
				terms: [
					{ term: '银行', reading: 'yínháng', meaning: 'bank', status: 'learning' },
					{ term: '', status: 'new' },
					{ term: '猫', status: 'sleeping' },
					{ term: '狗', status: 'known', reading: 3 },
					{ term: '书', status: 'new', reading: '' }
				]
			})
		).toEqual({
			language: 'zh-CN',
			languageName: 'Chinese',
			terms: [
				{ term: '银行', reading: 'yínháng', meaning: 'bank', status: 'learning' },
				{ term: '书', status: 'new' }
			]
		});
	});

	it('refuses a list that is not one', () => {
		expect(parseTermList(undefined)).toBeUndefined();
		expect(parseTermList({ language: null, languageName: 'x' })).toBeUndefined();
		expect(parseTermList({ language: 3, languageName: 'x', terms: [] })).toBeUndefined();
		expect(parseTermList({ language: null, languageName: '', terms: [] })).toEqual({
			language: null,
			languageName: '',
			terms: []
		});
	});
});

describe('inbox entries', () => {
	it('parses a whole entry and refuses a partial one', () => {
		expect(parseInboxEntry(entry({ reading: 'x' }))).toEqual(entry({ reading: 'x' }));
		expect(parseInboxEntry({ ...entry(), collectedAt: 'now' })).toBeUndefined();
		expect(parseInboxEntry({ ...entry(), term: ' ' })).toBeUndefined();
		const { url: _url, ...noUrl } = entry();
		expect(parseInboxEntry(noUrl)).toBeUndefined();
	});

	it('drops malformed entries from a reply', () => {
		expect(parseInbox({ entries: [entry(), { id: 'bad' }] })).toEqual([entry()]);
		expect(parseInbox([entry()])).toBeUndefined();
	});

	it('replaces the same word collected again on the same page', () => {
		const first = entry({ id: 'a', term: 'Gato' });
		const again = entry({ id: 'b', url: 'https://example.org/gatos#top', collectedAt: 2000 });
		const elsewhere = entry({ id: 'c', url: 'https://example.org/perros' });
		expect(addToInbox(addToInbox([first], elsewhere), again)).toEqual([elsewhere, again]);
	});

	it('removes by id', () => {
		const a = entry({ id: 'a' });
		const b = entry({ id: 'b', term: 'perro' });
		expect(removeFromInbox([a, b], ['a', 'z'])).toEqual([b]);
	});
});

describe('groupInbox', () => {
	it('groups by page, latest page first, words in collected order', () => {
		const a1 = entry({ id: 'a1', url: 'https://a.example/x#one', pageTitle: 'A', collectedAt: 1 });
		const b1 = entry({ id: 'b1', url: 'https://b.example/', pageTitle: '', collectedAt: 2 });
		const a2 = entry({ id: 'a2', url: 'https://a.example/x', pageTitle: 'A', collectedAt: 3 });
		expect(groupInbox([a2, b1, a1])).toEqual([
			{ url: 'https://a.example/x', title: 'A', entries: [a1, a2] },
			{ url: 'https://b.example/', title: 'b.example', entries: [b1] }
		]);
	});

	it('is empty for an empty inbox', () => {
		expect(groupInbox([])).toEqual([]);
	});

	it('keys a page without its fragment', () => {
		expect(pageKey('https://a.example/x#y')).toBe('https://a.example/x');
		expect(pageKey('https://a.example/x')).toBe('https://a.example/x');
	});
});

describe('listTerms', () => {
	const item = (term: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
		id: term,
		kind: 'vocab',
		term,
		meaning: `${term}-meaning`,
		introducedAt: 0,
		fsrsCard: null,
		history: [],
		...extra
	});

	it('lists garden words with their status, then known marks the garden does not hold', () => {
		const items = [item('银行', { romanization: 'yínháng' }), item('猫', { meaning: '' })];
		const status = (word: KnowledgeItem) => (word.term === '猫' ? 'learning' : 'new');
		expect(listTerms(items, ['猫', '狗'], status)).toEqual([
			{ term: '银行', reading: 'yínháng', meaning: '银行-meaning', status: 'new' },
			{ term: '猫', status: 'learning' },
			{ term: '狗', status: 'known' }
		]);
	});
});
