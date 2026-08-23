/**
 * The wire format: envelope (slice 1) plus the per-type payloads.
 *
 * These are round-trip tests rather than schema-shape tests — what matters is
 * that a payload the client *emits* is a payload the client *accepts*, since
 * both ends of a sync are this same code on two devices, and that everything
 * else is rejected quietly instead of throwing.
 */

import { describe, expect, it } from 'vitest';

import {
	EVENT_TYPES,
	SYNC_PAYLOAD_SCHEMAS,
	parseSyncPayload,
	storedSyncEventSchema,
	syncEventSchema,
	typeSyncEvent,
	type SyncEventType,
	type SyncPayloads
} from './events';

const AT = 1_700_000_000_000;
const UUID = '5b0e4a68-1d2a-4f9c-9a3e-6f1b2c3d4e5f';

/** One canonical payload per event type — the shapes the repositories capture. */
const payloads: { [T in SyncEventType]: SyncPayloads[T] } = {
	[EVENT_TYPES.itemAdded]: {
		id: 'i1',
		kind: 'vocab',
		term: '你好',
		meaning: 'hello',
		romanization: 'nǐ hǎo',
		notes: 'greeting',
		introducedAt: AT
	},
	[EVENT_TYPES.itemReviewed]: { itemId: 'i1', at: AT, grade: 3 },
	[EVENT_TYPES.reviewAmended]: { itemId: 'i1', at: AT + 5_000, grade: 4, replaces: AT },
	[EVENT_TYPES.itemUpdated]: { itemId: 'i1', fields: { notes: 'formal' } },
	[EVENT_TYPES.itemDeleted]: { itemId: 'i1' },
	[EVENT_TYPES.challengeAdded]: {
		challenge: {
			id: 'c1',
			type: 'cloze',
			direction: 'toTarget',
			itemIds: ['i1'],
			sentence: '我 ___ 你',
			acceptedAnswers: ['爱'],
			translationHint: 'I love you'
		},
		generatedAt: AT,
		topic: 'feelings'
	},
	[EVENT_TYPES.challengeServed]: { challengeId: 'c1' },
	[EVENT_TYPES.challengeReported]: { challengeId: 'c1' },
	[EVENT_TYPES.resultLogged]: {
		challengeId: 'c1',
		verdict: 'almost',
		answerGiven: '爱你',
		at: AT
	},
	[EVENT_TYPES.xpBanked]: { day: '2026-08-23', amount: 65 },
	[EVENT_TYPES.profileUpdated]: {
		nativeLanguage: 'en',
		targetLanguage: 'zh',
		level: 'beginner',
		interests: ['food'],
		about: 'A test learner.',
		dailyGoalXp: 50,
		model: 'test/model',
		createdAt: AT
	}
};

describe('payload schemas', () => {
	it('covers every event type in the vocabulary', () => {
		expect(Object.keys(SYNC_PAYLOAD_SCHEMAS).sort()).toEqual(Object.values(EVENT_TYPES).sort());
	});

	it('round-trips every canonical payload', () => {
		for (const [type, payload] of Object.entries(payloads)) {
			expect(parseSyncPayload(type as SyncEventType, payload)).toEqual(payload);
		}
	});

	it('round-trips a payload that has been through JSON, as the wire will', () => {
		for (const [type, payload] of Object.entries(payloads)) {
			const wire: unknown = JSON.parse(JSON.stringify(payload));
			expect(parseSyncPayload(type as SyncEventType, wire)).toEqual(payload);
		}
	});

	it('carries unknown challenge fields through verbatim', () => {
		const parsed = parseSyncPayload(EVENT_TYPES.challengeAdded, {
			challenge: {
				id: 'c9',
				type: 'match-pairs',
				direction: 'toNative',
				itemIds: ['i1', 'i2'],
				pairs: [{ a: '猫', b: 'cat', aRom: 'māo' }],
				somethingNewerClientsEmit: 42
			},
			generatedAt: AT
		});

		expect(parsed?.challenge).toMatchObject({
			pairs: [{ a: '猫', b: 'cat', aRom: 'māo' }],
			somethingNewerClientsEmit: 42
		});
	});

	it('rejects malformed payloads instead of throwing', () => {
		expect(parseSyncPayload(EVENT_TYPES.itemReviewed, { itemId: 'i1', at: AT })).toBeUndefined();
		expect(
			parseSyncPayload(EVENT_TYPES.itemReviewed, { itemId: 'i1', at: AT, grade: 9 })
		).toBeUndefined();
		expect(parseSyncPayload(EVENT_TYPES.xpBanked, { day: '23-08-2026', amount: 1 })).toBeUndefined();
		expect(parseSyncPayload(EVENT_TYPES.itemDeleted, null)).toBeUndefined();
		expect(
			parseSyncPayload(EVENT_TYPES.challengeAdded, {
				challenge: { id: 'c1', type: 'crossword', direction: 'toTarget', itemIds: [] },
				generatedAt: AT
			})
		).toBeUndefined();
	});

	it('rejects an item patch that tries to rewrite identity', () => {
		const parsed = parseSyncPayload(EVENT_TYPES.itemUpdated, {
			itemId: 'i1',
			fields: { term: 'ok', id: 'i2', introducedAt: 1 }
		});
		expect(parsed?.fields).toEqual({ term: 'ok' });
	});

	it('treats an unknown event type as undefined, not an error', () => {
		expect(parseSyncPayload('item-hyperlearned' as SyncEventType, {})).toBeUndefined();
	});
});

describe('typeSyncEvent', () => {
	const envelope = {
		id: UUID,
		device: 'devA',
		at: AT,
		type: EVENT_TYPES.itemDeleted,
		payload: { itemId: 'i1' }
	};

	it('narrows a valid event', () => {
		const typed = typeSyncEvent(envelope);
		expect(typed).toEqual(envelope);
		expect(typed?.type).toBe(EVENT_TYPES.itemDeleted);
	});

	it('returns undefined for a payload that does not fit its type', () => {
		expect(typeSyncEvent({ ...envelope, payload: { challengeId: 'c1' } })).toBeUndefined();
	});
});

describe('envelope', () => {
	it('still accepts an event carrying any of the known payloads', () => {
		for (const [type, payload] of Object.entries(payloads)) {
			const parsed = syncEventSchema.safeParse({ id: UUID, device: 'devA', at: AT, type, payload });
			expect(parsed.success).toBe(true);
		}
	});

	it('accepts a pulled event with its seq', () => {
		const parsed = storedSyncEventSchema.safeParse({
			id: UUID,
			device: 'devA',
			at: AT,
			type: EVENT_TYPES.itemDeleted,
			payload: { itemId: 'i1' },
			seq: 12
		});
		expect(parsed.success).toBe(true);
	});
});
