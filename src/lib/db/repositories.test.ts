/**
 * Repository-level query shape: the things worth pinning down are that a lean
 * read stays lean (`poolSize`, `getAllItems`'s default column list) and that a
 * narrower `WHERE` still tells the truth (`upsertItems`'s add-vs-update split).
 *
 * Runs against a real store — the same WASM SQLite the browser runs, in
 * memory — so what is asserted is the query's actual behaviour.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	addConversation,
	addExchange,
	addText,
	deleteConversation,
	deleteText,
	getAllItems,
	getConversation,
	getConversations,
	getItem,
	getKnownTerms,
	getText,
	getTexts,
	markWord,
	poolSize,
	recordLookup,
	upsertItems
} from '$lib/db';
import { setStoreForTesting, type Store } from './store';
import { makeTestStore } from './store.testing';
import { newCardState } from '$lib/srs';
import type {
	Challenge,
	Conversation,
	ConversationExchange,
	KnowledgeItem,
	ReadingText
} from '$lib/types';

let store: Store;

beforeEach(async () => {
	store = await makeTestStore();
	setStoreForTesting(store);
});

function item(id: string, term: string, introducedAt: number): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term,
		meaning: 'book',
		introducedAt,
		fsrsCard: newCardState(introducedAt),
		history: []
	};
}

const challenge = {
	id: 'c1',
	type: 'multiple-choice',
	direction: 'toTarget',
	itemIds: ['i1'],
	prompt: 'book?',
	options: ['书', '水'],
	answerIndex: 0
} as unknown as Challenge;

describe('poolSize', () => {
	it('counts the pool without reading its rows', async () => {
		expect(await poolSize()).toBe(0);

		await store.commit('challengeAdded', { challenge, generatedAt: 1000 });
		expect(await poolSize()).toBe(1);
	});

	it('excludes reported challenges, same as getPool', async () => {
		await store.commit('challengeAdded', { challenge, generatedAt: 1000 });
		await store.commit('challengeReported', { challengeId: 'c1' });

		expect(await poolSize()).toBe(0);
	});
});

describe('getAllItems', () => {
	it('omits recentGrades by default', async () => {
		await upsertItems([item('i1', '书', 1000)]);
		await store.commit('itemReviewed', { device: 'dev', at: 2000, itemId: 'i1', grade: 3 });

		const [loaded] = await getAllItems();
		expect(loaded.recentGrades).toBeUndefined();
		// The aggregates that are single columns still come along.
		expect(loaded.reviewCount).toBe(1);
		expect(loaded.correctCount).toBe(1);
		expect(loaded.history).toEqual([]);
	});

	it('carries recentGrades when asked for it, matching getItem', async () => {
		await upsertItems([item('i1', '书', 1000)]);
		await store.commit('itemReviewed', { device: 'dev', at: 2000, itemId: 'i1', grade: 3 });

		const [loaded] = await getAllItems({ withRecentGrades: true });
		const alone = await getItem('i1');

		expect(loaded.recentGrades).toEqual([{ at: 2000, grade: 3 }]);
		expect(loaded.recentGrades).toEqual(alone?.recentGrades);
	});
});

describe('upsertItems', () => {
	it('adds a new id and updates a known one, in the same call', async () => {
		await upsertItems([item('i1', '书', 1000)]);

		// i1 already exists; i2 is new. One call, two different fact types.
		await upsertItems([item('i1', '書', 1000), item('i2', '旧', 1500)]);

		const updated = await getItem('i1');
		const added = await getItem('i2');

		// itemUpdated never touches introducedAt or the card — only itemAdded does
		// — so a wrong add/update split would show up here as a clobbered date.
		expect(updated?.term).toBe('書');
		expect(updated?.introducedAt).toBe(1000);
		expect(added?.term).toBe('旧');
		expect(added?.introducedAt).toBe(1500);
	});

	it('still tells add from update when more ids are known than are passed', async () => {
		// Several existing items, so the fix (WHERE id IN (...) over the passed
		// ids) is actually exercised rather than degenerating to "the only row".
		await upsertItems([item('i1', 'a', 1), item('i2', 'b', 2), item('i3', 'c', 3)]);

		await upsertItems([item('i2', 'b2', 2), item('i4', 'd', 4)]);

		expect((await getItem('i2'))?.term).toBe('b2');
		expect((await getItem('i2'))?.introducedAt).toBe(2);
		expect((await getItem('i4'))?.introducedAt).toBe(4);
	});
});

function text(id: string, title: string, createdAt: number, topic?: string): ReadingText {
	return {
		id,
		title,
		source: 'generated',
		...(topic === undefined ? {} : { topic }),
		sentences: [
			{ text: '我想买书。', reading: 'wǒ xiǎng mǎi shū.', translation: 'I want a book.' }
		],
		glossary: [{ term: '书', reading: 'shū', meaning: 'book' }],
		createdAt
	};
}

describe('reading texts', () => {
	it('round-trips a text whole, and lists newest first', async () => {
		await addText(text('t1', '买书', 1000));
		await addText(text('t2', '喝水', 2000, 'drinks'));

		expect((await getTexts()).map((row) => row.id)).toEqual(['t2', 't1']);
		// JSON columns come back as the objects that went in, topic included.
		expect(await getText('t2')).toEqual(text('t2', '喝水', 2000, 'drinks'));
	});

	it('leaves an unset topic absent rather than null', async () => {
		await addText(text('t1', '买书', 1000));

		const loaded = await getText('t1');
		expect(loaded && 'topic' in loaded).toBe(false);
	});

	it('deletes a text, and getText stops finding it', async () => {
		await addText(text('t1', '买书', 1000));
		await deleteText('t1');

		expect(await getTexts()).toEqual([]);
		expect(await getText('t1')).toBeUndefined();
	});

	// The follow view is built entirely out of these two, and both live in the
	// payload rather than in a column of their own — so the thing that can quietly
	// break them is the event schema, which strips whatever it is not told about.
	it('keeps a subtitle import’s timings and its media reference', async () => {
		const imported: ReadingText = {
			id: 't3',
			title: '一课',
			source: 'imported',
			sentences: [
				{ text: '我想买书。', translation: 'I want a book.', start: 1200, end: 3400 },
				{ text: '好的。', translation: 'All right.', start: 3400, end: 4000 }
			],
			glossary: [],
			media: { kind: 'file', name: 'lesson.mp4', type: 'video/mp4' },
			createdAt: 5000
		};

		await addText(imported);

		expect(await getText('t3')).toEqual(imported);
	});

	it('leaves an unset media absent rather than null', async () => {
		await addText(text('t1', '买书', 1000));

		const loaded = await getText('t1');
		expect(loaded && 'media' in loaded).toBe(false);
	});
});

describe('word marks', () => {
	it('lists the terms still marked known', async () => {
		await markWord('水', true);
		await markWord('书', true);
		await markWord('水', false);

		expect((await getKnownTerms()).sort()).toEqual(['书']);
	});

	it('stores the term trimmed, so re-marking finds the same row', async () => {
		await markWord('  水  ', true);
		expect(await getKnownTerms()).toEqual(['水']);

		await markWord('水', false);
		expect(await getKnownTerms()).toEqual([]);
	});
});

describe('recordLookup', () => {
	it('keeps every tap, and leaves itemId null when the word is untracked', async () => {
		// Nothing reads `lookups` yet, so the query is the assertion: two taps on
		// the same word must be two rows, because the count is the signal a later
		// slice reads.
		await recordLookup('  书  ', 't1', 'i1');
		await recordLookup('书', 't1');

		const rows = await store.query<{ term: string; itemId: string | null; textId: string }>(
			'SELECT term, itemId, textId FROM lookups ORDER BY rowid'
		);
		expect(rows).toEqual([
			{ term: '书', itemId: 'i1', textId: 't1' },
			{ term: '书', itemId: null, textId: 't1' }
		]);
	});

	it('ignores a blank term', async () => {
		await recordLookup('   ', 't1');
		expect(await store.query('SELECT * FROM lookups')).toEqual([]);
	});
});

function conversation(id: string, createdAt: number, topic?: string): Conversation {
	return {
		id,
		scenario: {
			setting: 'An ice cream shop on a hot afternoon.',
			teacherRole: 'the person behind the counter',
			learnerRole: 'a customer',
			firstSpeaker: 'teacher',
			opener: { text: '¡Hola!' },
			openerTranslation: 'Hello!'
		},
		...(topic === undefined ? {} : { topic }),
		createdAt
	};
}

function exchange(id: string, index: number, said: string): ConversationExchange {
	return {
		conversationId: id,
		index,
		learner: { role: 'learner', text: said },
		teacher: {
			role: 'teacher',
			reply: { text: 'Muy bien.' },
			translation: 'Very good.',
			actions: []
		}
	};
}

describe('conversations', () => {
	it('round-trips a scene and its transcript, in order, newest conversation first', async () => {
		await addConversation(conversation('c1', 1000));
		await addConversation(conversation('c2', 2000, 'coffee'));

		// Out of order on purpose: the read orders by idx, not by arrival.
		await addExchange(exchange('c1', 1, 'un helado'));
		await addExchange({
			conversationId: 'c1',
			index: 0,
			teacher: { role: 'teacher', reply: { text: '¡Hola!' }, actions: [] }
		});

		const summaries = await getConversations();
		expect(summaries.map((row) => row.id)).toEqual(['c2', 'c1']);
		expect(summaries.map((row) => row.turnCount)).toEqual([0, 2]);
		expect(summaries[0].topic).toBe('coffee');

		const loaded = await getConversation('c1');
		expect(loaded?.conversation).toEqual(conversation('c1', 1000));
		expect(loaded?.exchanges.map((row) => row.index)).toEqual([0, 1]);
		// The opener has no learner half; the exchange after it does, whole.
		expect(loaded?.exchanges[0].learner).toBeUndefined();
		expect(loaded?.exchanges[1]).toEqual(exchange('c1', 1, 'un helado'));
	});

	it('leaves an unset topic absent rather than null', async () => {
		await addConversation(conversation('c1', 1000));

		const loaded = await getConversation('c1');
		expect(loaded && 'topic' in loaded.conversation).toBe(false);
	});

	it('keeps heard and correction on the learner turn they were about', async () => {
		await addConversation(conversation('c1', 1000));
		await addExchange({
			conversationId: 'c1',
			index: 0,
			learner: {
				role: 'learner',
				text: 'quiero un helado',
				heard: { text: 'Quiero un helado.' },
				correction: { corrected: { text: 'Quiero un helado.' }, note: 'Capital and full stop.' }
			},
			teacher: { role: 'teacher', reply: { text: 'Claro.' }, actions: [] }
		});

		const loaded = await getConversation('c1');
		expect(loaded?.exchanges[0].learner?.correction?.note).toBe('Capital and full stop.');
		expect(loaded?.exchanges[0].learner?.heard).toEqual({ text: 'Quiero un helado.' });
	});

	it('ignores a second exchange at an index it already has', async () => {
		// Two devices continuing the same conversation is the accepted edge: the
		// pair (conversationId, idx) is the identity, so one of them wins whole.
		await addConversation(conversation('c1', 1000));
		await addExchange(exchange('c1', 0, 'first'));
		await addExchange(exchange('c1', 0, 'second'));

		const loaded = await getConversation('c1');
		expect(loaded?.exchanges).toHaveLength(1);
		expect(loaded?.exchanges[0].learner?.text).toBe('first');
	});

	it('keeps a turn that arrived before the conversation it belongs to', async () => {
		// Sync has no causal order across devices; a turn dropped for arriving
		// early would never come back.
		await addExchange(exchange('c1', 0, 'un helado'));
		expect(await getConversation('c1')).toBeUndefined();

		await addConversation(conversation('c1', 1000));
		expect((await getConversation('c1'))?.exchanges).toHaveLength(1);
	});

	it('tombstones a deletion, so a replayed start or turn stays gone', async () => {
		await addConversation(conversation('c1', 1000));
		await addExchange(exchange('c1', 0, 'un helado'));
		await deleteConversation('c1');

		expect(await getConversations()).toEqual([]);
		expect(await getConversation('c1')).toBeUndefined();

		// Another device's copy of the same conversation, arriving late.
		await addConversation(conversation('c1', 1000));
		await addExchange(exchange('c1', 1, 'y un café'));

		expect(await getConversations()).toEqual([]);
		expect(await store.query('SELECT * FROM conversationTurns')).toEqual([]);
	});
});
