/**
 * The event model: ten immutable facts, and the only thing sync ever moves.
 *
 * The envelope `id` is the set-union key — an id already in `events` is never
 * materialised twice — so no payload carries an id of its own. `at` is when the
 * learner did the thing, and doubles as the last-write-wins input for the two
 * overwrites (`itemUpdated`, `profileUpdated`); every other rule is
 * order-independent by construction.
 *
 * Payload shapes are frozen: they are what v3 export files on disk contain.
 */
import { z } from 'zod';

export type EventType =
	| 'itemAdded'
	| 'itemReviewed'
	| 'reviewAmended'
	| 'itemUpdated'
	| 'itemDeleted'
	| 'challengeAdded'
	| 'challengeServed'
	| 'challengeReported'
	| 'resultLogged'
	| 'profileUpdated';

export interface SyncEvent {
	id: string;
	type: EventType;
	at: number;
	device: string;
	payload: unknown;
}

/** A remote event, carrying the sequence number the backend assigned it. */
export type SequencedEvent = SyncEvent & { seq: number };

const level = z.enum(['beginner', 'elementary', 'intermediate', 'advanced']);

export const payloadSchemas = {
	/** Item content only. The card is computed from the reviews that follow. */
	itemAdded: z.object({
		id: z.string(),
		kind: z.enum(['vocab', 'grammar']),
		term: z.string(),
		meaning: z.string(),
		romanization: z.string().optional(),
		notes: z.string().optional(),
		introducedAt: z.number()
	}),

	/** One review. Identity is `(itemId, at, device)`. */
	itemReviewed: z.object({
		device: z.string(),
		at: z.number(),
		itemId: z.string(),
		grade: z.number()
	}),

	/** A re-grade. `replaces` names the `at` of the review it displaced. */
	reviewAmended: z.object({
		device: z.string(),
		at: z.number(),
		itemId: z.string(),
		grade: z.number(),
		replaces: z.number().optional()
	}),

	/** A patch of the mutable fields; identity and birth date are immutable. */
	itemUpdated: z.object({
		itemId: z.string(),
		fields: z.object({
			term: z.string().optional(),
			meaning: z.string().optional(),
			romanization: z.string().optional(),
			notes: z.string().optional()
		})
	}),

	/** Tombstone. The item and its reviews go, and the id can never come back. */
	itemDeleted: z.object({ itemId: z.string() }),

	/**
	 * Immutable challenge content plus its pool metadata.
	 *
	 * `challenge` is unvalidated on purpose: a schema that named fields would
	 * strip the ones it did not know about, and the producer already validated
	 * the content at generation time. The `type` allow-list is enforced in the
	 * materializer, where an unknown type costs one skipped row rather than a
	 * rejected event.
	 */
	challengeAdded: z.object({
		challenge: z.unknown(),
		generatedAt: z.number(),
		topic: z.string().optional()
	}),

	/** One serve. `timesServed` counts distinct such events. */
	challengeServed: z.object({ challengeId: z.string(), at: z.number() }),

	/** Permanent exclusion. A sticky boolean, so it needs no ordering data. */
	challengeReported: z.object({ challengeId: z.string() }),

	/** One answered challenge, set-unioned by the envelope id. */
	resultLogged: z.object({
		challengeId: z.string(),
		verdict: z.enum(['correct', 'almost', 'wrong']),
		answerGiven: z.string(),
		at: z.number()
	}),

	/** The whole profile, last write by `at` wins. */
	profileUpdated: z.object({
		nativeLanguage: z.string(),
		targetLanguage: z.string(),
		level,
		interests: z.array(z.string()),
		about: z.string().optional(),
		model: z.string(),
		createdAt: z.number()
	})
} satisfies Record<EventType, z.ZodType>;

export type PayloadFor<T extends EventType> = z.infer<(typeof payloadSchemas)[T]>;

const envelope = z.object({
	id: z.string(),
	type: z.string(),
	at: z.number(),
	device: z.string(),
	payload: z.unknown()
});

function isEventType(type: string): type is EventType {
	return type in payloadSchemas;
}

/**
 * Validates one event off the wire or out of an export file.
 *
 * `undefined` for an unknown type or a payload that will not parse — the caller
 * skips it and keeps going, so one bad row never costs a whole import.
 */
export function parseEvent(raw: unknown): SyncEvent | undefined {
	const outer = envelope.safeParse(raw);
	if (!outer.success) return undefined;
	const { id, type, at, device, payload } = outer.data;
	if (!isEventType(type)) return undefined;
	const parsed = payloadSchemas[type].safeParse(payload);
	if (!parsed.success) return undefined;
	return { id, type, at, device, payload: parsed.data };
}
