/**
 * The event model: seventeen immutable facts, and the only thing sync ever moves.
 *
 * The envelope `id` is the set-union key — an id already in `events` is never
 * materialised twice — so no payload carries an id of its own. `at` is when the
 * learner did the thing, and doubles as the last-write-wins input for the three
 * overwrites (`itemUpdated`, `profileUpdated`, `wordMarked`); every other rule
 * is order-independent by construction.
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
	| 'profileUpdated'
	| 'textAdded'
	| 'textDeleted'
	| 'wordMarked'
	| 'wordLookedUp'
	| 'conversationStarted'
	| 'turnAdded'
	| 'conversationDeleted';

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

/**
 * The conversation shapes, as `$lib/conversation` hands them to the page.
 *
 * `.optional()` throughout, not `.nullish()` like the generation-side mirrors:
 * these never come off the wire. `parseScenario` and `parseTeacherReply` have
 * already normalized every model-emitted `null` to absent by the time a turn
 * reaches the page, so a `null` here would be a bug and not a dialect —
 * the same reason `textAdded` writes its sentences and glossary `.optional()`.
 */
const line = z.object({ text: z.string(), reading: z.string().optional() });

const learnerTurn = z.object({
	role: z.literal('learner'),
	text: z.string(),
	heard: line.optional(),
	correction: z.object({ corrected: line, note: z.string().optional() }).optional()
});

const teacherTurn = z.object({
	role: z.literal('teacher'),
	reply: line,
	translation: z.string().optional(),
	actions: z.array(z.object({ tool: z.string(), summary: z.string(), ok: z.boolean() }))
});

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
	}),

	/**
	 * One whole reading text, annotations and all.
	 *
	 * A text is immutable once stored — there is no `textUpdated` — so the only
	 * ordering question is against its own tombstone, which the materializer
	 * answers the way `itemAdded` does.
	 */
	textAdded: z.object({
		id: z.string(),
		title: z.string(),
		source: z.enum(['generated', 'imported']),
		topic: z.string().optional(),
		sentences: z.array(
			z.object({
				text: z.string(),
				reading: z.string().optional(),
				translation: z.string().optional()
			})
		),
		glossary: z.array(
			z.object({
				term: z.string(),
				reading: z.string().optional(),
				meaning: z.string()
			})
		),
		createdAt: z.number()
	}),

	/** Tombstone. The text goes, and the id can never come back. */
	textDeleted: z.object({ textId: z.string() }),

	/**
	 * "I know this word" / "I don't", off a word card. A toggle, so it needs the
	 * envelope `at` to resolve: last write by `at` wins, per term.
	 */
	wordMarked: z.object({ term: z.string(), known: z.boolean() }),

	/**
	 * The learner opened a word's card in a text — "I don't understand this".
	 *
	 * Recorded although nothing reads it yet: a lookup on a *tracked* word is
	 * FSRS evidence, and it is the one thing about a reading session that cannot
	 * be reconstructed afterwards. `itemId` is present when the word was already
	 * in the garden, which is exactly the case a later slice will grade.
	 */
	wordLookedUp: z.object({
		term: z.string(),
		itemId: z.string().optional(),
		textId: z.string()
	}),

	/**
	 * The scene, decided once and never revised — there is no
	 * `conversationUpdated`, for the same reason there is no `textUpdated`.
	 *
	 * A conversation grows only by {@link turnAdded}, which is what makes an
	 * append-only log the natural home for one: the transcript *is* a sequence of
	 * facts, so persisting it costs no merge rules beyond insert-or-ignore.
	 */
	conversationStarted: z.object({
		id: z.string(),
		scenario: z.object({
			setting: z.string(),
			teacherRole: z.string(),
			learnerRole: z.string(),
			firstSpeaker: z.enum(['teacher', 'learner']),
			opener: line.optional(),
			openerTranslation: z.string().optional()
		}),
		topic: z.string().optional(),
		createdAt: z.number()
	}),

	/**
	 * One completed exchange: what the learner said, and the reply that came
	 * back. Identity is `(conversationId, index)` — content, not anything
	 * device-local — so two devices that continued the same conversation collapse
	 * to one turn rather than interleaving two.
	 *
	 * `learner` is absent only at index 0, where the scenario's opener seeds the
	 * transcript with a line nobody prompted. A learner message whose reply failed
	 * is never written: stored history always ends on a teacher turn, which is
	 * what the dialogue replay in `$lib/conversation` expects to resume from.
	 */
	turnAdded: z.object({
		conversationId: z.string(),
		index: z.number(),
		learner: learnerTurn.optional(),
		teacher: teacherTurn
	}),

	/** Tombstone. The conversation and its turns go, and the id can never come back. */
	conversationDeleted: z.object({ conversationId: z.string() })
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
