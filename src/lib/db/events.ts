/**
 * The event model shared with the sync log (see the migration plan's "event
 * model" section). Types only for now — zod validation and `parseEvent` land
 * with the SQLite data layer.
 */

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
