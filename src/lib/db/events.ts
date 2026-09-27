/**
 * The event model: seventeen immutable facts, and the only thing sync ever moves.
 *
 * The types are generated from `crates/sapling-domain/src/events.rs`, where the
 * schemas that *enforce* them live — the gate every event off sync or out of a
 * backup file passes through — so a payload here cannot name a field the Rust
 * struct does not. Change the struct and run `pnpm core:types`. What stays
 * written here is TypeScript-only: the refinements a test writes events with.
 */
import type { EventType, LogRow, Payloads } from './generated/index';

export type {
	ChallengeAddedPayload,
	ChallengeReportedPayload,
	ChallengeServedPayload,
	ConversationDeletedPayload,
	EventType,
	ItemAddedPayload,
	ItemDeletedPayload,
	ItemFields,
	ItemReviewedPayload,
	ItemUpdatedPayload,
	LogRow,
	Payloads,
	ReviewAmendedPayload,
	TextDeletedPayload,
	WordLookedUpPayload,
	WordMarkedPayload
} from './generated/index';

/** A log row this build knows the type of — what a merge rule is written against. */
export interface SyncEvent extends LogRow {
	type: EventType;
}

export type PayloadFor<T extends EventType> = Payloads[T];

/** One local fact before it has an envelope — what a test rig seeds a store with. */
export type Fact = { [T in EventType]: { type: T; payload: PayloadFor<T> } }[EventType];
