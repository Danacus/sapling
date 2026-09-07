/**
 * The event model: seventeen immutable facts, and the only thing sync ever moves.
 *
 * The envelope `id` is the set-union key — an id already in `events` is never
 * materialised twice — so no payload carries an id of its own. `at` is when the
 * learner did the thing, and doubles as the last-write-wins input for the two
 * overwrites (`profileUpdated`, `wordMarked`) and the per-field fold of
 * `itemUpdated`; every other rule is order-independent by construction.
 *
 * Payload shapes are frozen: they are what v3 export files on disk contain.
 *
 * These are types only. The schemas that *enforce* them — the gate every event
 * off sync or out of a backup file passes through — live with the merge rules
 * in `crates/sapling-core/src/events.rs`, and the golden fixtures pin that
 * `parseEvent(raw)` equals `raw` for every type. A type here that names a field
 * the Rust struct does not is a bug on the device that receives it, so the two
 * are kept field for field.
 */
import type {
	ChallengeResult,
	Conversation,
	ConversationExchange,
	Profile,
	ReadingText
} from '$lib/types';

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

/**
 * One row of the log, exactly as it is stored — and exactly what push and
 * export ship.
 *
 * `type` is a plain string here, not an {@link EventType}, because neither of
 * those two may require that *this* build understands the row: a kind a newer
 * build wrote, or a payload whose schema has since widened, has to survive a
 * round trip through an older device rather than be dropped. Only the
 * materializer parses a payload, and a row it cannot read is skipped, never
 * dropped from the log.
 */
export interface LogRow {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: unknown;
}

/** A log row this build knows the type of — what a merge rule is written against. */
export interface SyncEvent extends LogRow {
	type: EventType;
}

/** A remote event, carrying the sequence number the backend assigned it. */
export type SequencedEvent = SyncEvent & { seq: number };

/** Item content only. The card is computed from the reviews that follow. */
export interface ItemAddedPayload {
	id: string;
	kind: 'vocab' | 'grammar';
	term: string;
	meaning: string;
	romanization?: string;
	notes?: string;
	introducedAt: number;
}

/** One review. Identity is `(itemId, at, device)`. */
export interface ItemReviewedPayload {
	device: string;
	at: number;
	itemId: string;
	grade: number;
}

/** A re-grade. `replaces` names the `at` of the review it displaced. */
export interface ReviewAmendedPayload extends ItemReviewedPayload {
	replaces?: number;
}

/** A patch of the mutable fields; identity and birth date are immutable. */
export interface ItemUpdatedPayload {
	itemId: string;
	fields: {
		term?: string;
		meaning?: string;
		romanization?: string;
		notes?: string;
	};
}

/**
 * Immutable challenge content plus its pool metadata.
 *
 * `challenge` is unvalidated on purpose: a schema that named fields would strip
 * the ones it did not know about, and the producer already validated the
 * content at generation time. The `type` allow-list is enforced in the
 * materializer, where an unknown type costs one skipped row rather than a
 * rejected event.
 */
export interface ChallengeAddedPayload {
	challenge: unknown;
	generatedAt: number;
	topic?: string;
}

/** One serve. `timesServed` counts distinct such events. */
export interface ChallengeServedPayload {
	challengeId: string;
	at: number;
}

/**
 * "I know this word" / "I don't", off a word card. A toggle, so it needs the
 * envelope `at` to resolve: last write by `at` wins, per term.
 */
export interface WordMarkedPayload {
	term: string;
	known: boolean;
}

/**
 * The learner opened a word's card in a text — "I don't understand this".
 *
 * Recorded although nothing reads it yet: a lookup on a *tracked* word is FSRS
 * evidence, and it is the one thing about a reading session that cannot be
 * reconstructed afterwards. `itemId` is present when the word was already in
 * the garden, which is exactly the case a later slice will grade.
 */
export interface WordLookedUpPayload {
	term: string;
	itemId?: string;
	textId: string;
}

/**
 * Every payload, by type. Five of them are domain types verbatim: the whole
 * profile (last write by `at` wins), one answered challenge (set-unioned by the
 * envelope id), one whole reading text, one conversation's scene, and one
 * completed exchange — all immutable once written, so the only ordering
 * question any of them raises is against its own tombstone.
 */
export interface Payloads {
	itemAdded: ItemAddedPayload;
	itemReviewed: ItemReviewedPayload;
	reviewAmended: ReviewAmendedPayload;
	itemUpdated: ItemUpdatedPayload;
	/** Tombstone. The item and its reviews go, and the id can never come back. */
	itemDeleted: { itemId: string };
	challengeAdded: ChallengeAddedPayload;
	challengeServed: ChallengeServedPayload;
	/** Permanent exclusion. A sticky boolean, so it needs no ordering data. */
	challengeReported: { challengeId: string };
	resultLogged: ChallengeResult;
	profileUpdated: Profile;
	textAdded: ReadingText;
	/** Tombstone. The text goes, and the id can never come back. */
	textDeleted: { textId: string };
	wordMarked: WordMarkedPayload;
	wordLookedUp: WordLookedUpPayload;
	conversationStarted: Conversation;
	turnAdded: ConversationExchange;
	/** Tombstone. The conversation and its turns go, and the id can never come back. */
	conversationDeleted: { conversationId: string };
}

export type PayloadFor<T extends EventType> = Payloads[T];

/** One local fact before it has an envelope — what a test rig seeds a store with. */
export type Fact = { [T in EventType]: { type: T; payload: PayloadFor<T> } }[EventType];
