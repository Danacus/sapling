/**
 * The wire format: envelope (slice 1) plus the per-type payloads.
 *
 * These are round-trip tests rather than schema-shape tests — what matters is
 * that a payload the client *emits* is a payload the client *accepts*, since
 * both ends of a sync are this same code on two devices, and that everything
 * else is rejected quietly instead of throwing.
 */

import { describe, expect, it } from 'vitest';

import type { ChallengeType } from '$lib/types';

import {
	EVENT_TYPES,
	SYNC_PAYLOAD_SCHEMAS,
	challengeContentSchema,
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

	it('accepts every member of the stored Challenge union', () => {
		// The `type` allow-list is the one field of the challenge payload that has
		// to be kept in step with `$lib/types` — a type missing from it is a
		// challenge that silently never arrives on the other device.
		const shapes: Record<string, unknown>[] = [
			{ id: 'c1', type: 'multiple-choice', direction: 'toNative', itemIds: ['i1'] },
			{ id: 'c2', type: 'cloze', direction: 'toTarget', itemIds: ['i1'] },
			{ id: 'c3', type: 'typed-translation', direction: 'toTarget', itemIds: ['i1'] },
			{ id: 'c4', type: 'match-pairs', direction: 'toNative', itemIds: ['i1'] },
			{
				id: 'c5',
				type: 'word-order',
				direction: 'toTarget',
				itemIds: ['i1'],
				tiles: ['买单', '我们', '想'],
				answerTokens: ['我们', '想', '买单'],
				answer: '我们想买单'
			},
			{
				id: 'c6',
				type: 'spot-error',
				direction: 'toNative',
				itemIds: ['i1'],
				tokens: ['我们', '想', '菜单'],
				correctIndex: 2,
				intendedWord: '买单',
				correctedSentence: '我们想买单',
				meaning: 'We would like to pay the bill.'
			}
		];

		for (const challenge of shapes) {
			const parsed = parseSyncPayload(EVENT_TYPES.challengeAdded, { challenge, generatedAt: AT });
			expect(parsed?.challenge).toEqual(challenge);
		}
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

/**
 * `challengeContentSchema.type` is an allow-list, and `events.ts` cannot import
 * `$lib/types` to derive it (the file is shared verbatim with the server, which
 * compiles it by relative path). So the list is maintained by hand, and a
 * challenge type missing from it is dropped on the *receiving* device — a
 * failure mode that is invisible on the device that generated it.
 *
 * This is the guard rail. `CHALLENGE_TYPES` is a total record over
 * `ChallengeType`: adding a member to the union in `$lib/types` fails to
 * compile here, and filling it in then fails the assertion below until
 * `events.ts` has been updated too.
 */
describe('challengeContentSchema type allow-list', () => {
	const CHALLENGE_TYPES: { [T in ChallengeType]: true } = {
		'multiple-choice': true,
		cloze: true,
		'typed-translation': true,
		'match-pairs': true,
		'word-order': true,
		'spot-error': true
	};

	/** The enum as `events.ts` actually declares it, read back through zod. */
	const declared: readonly string[] = challengeContentSchema.shape.type.options;

	it('matches the stored Challenge union exactly', () => {
		expect([...declared].sort()).toEqual(Object.keys(CHALLENGE_TYPES).sort());
	});

	it('lists each type once', () => {
		expect(new Set(declared).size).toBe(declared.length);
	});

	it('accepts every listed type and drops anything else', () => {
		for (const type of declared) {
			const parsed = challengeContentSchema.safeParse({
				id: 'c1',
				type,
				direction: 'toTarget',
				itemIds: ['i1']
			});
			expect(parsed.success).toBe(true);
		}
		const unknown = challengeContentSchema.safeParse({
			id: 'c1',
			type: 'dictation',
			direction: 'toTarget',
			itemIds: ['i1']
		});
		expect(unknown.success).toBe(false);
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
