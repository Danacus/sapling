/**
 * Genesis: turning a device's existing data into the events that would have
 * produced it (docs/sync.md §5).
 *
 * There is no snapshot format and no bootstrap endpoint — the log is the only
 * mechanism, so a device that has been learning for months before sync was
 * configured simply *back-dates* the log it never wrote. Everything downstream
 * (the server, the apply engine, another device) then sees an ordinary history.
 *
 * That also settles what capture has to do: since genesis must exist anyway,
 * outbox capture can be opt-in and start the moment sync is configured (§11.1),
 * with genesis covering everything before that instant. The two meet exactly.
 *
 * Pure, with an injectable id factory so tests can pin the output.
 */

import { getDeviceId, newUuid } from './config';
import { EVENT_TYPES, type SyncEvent, type SyncEventType, type SyncPayloads } from './events';
import { seedOutbox } from '$lib/db';
import type { GenesisState } from './snapshot';

/**
 * Builds the event log that reproduces `state`.
 *
 * Timestamps are the domain's own wherever the domain has one — `introducedAt`,
 * each history entry's `at`, `generatedAt`, a result's `at` — so a genesis log
 * interleaves correctly with real events from other devices rather than piling
 * up at the moment sync was switched on.
 *
 * One of them is necessarily an approximation, and harmless: a pool row
 * remembers only `timesServed` and `lastServedAt`, so all `timesServed`
 * synthetic serve events are stamped at `lastServedAt` (§5). The count stays
 * exact — which is the field the recycling policy reads — and only the spacing
 * between past serves is lost, which nothing reads.
 *
 * The result is returned in `(at, device, id)` order, the same order the apply
 * engine will fold it in.
 */
export function synthesizeGenesis(
	state: GenesisState,
	deviceId: string,
	newId: () => string
): SyncEvent[] {
	const events: SyncEvent[] = [];
	const emit = <T extends SyncEventType>(type: T, payload: SyncPayloads[T], at: number): void => {
		events.push({ id: newId(), device: deviceId, at, type, payload });
	};

	for (const item of state.items) {
		emit(
			EVENT_TYPES.itemAdded,
			{
				id: item.id,
				kind: item.kind,
				term: item.term,
				meaning: item.meaning,
				romanization: item.romanization,
				notes: item.notes,
				introducedAt: item.introducedAt
			},
			item.introducedAt
		);
		for (const entry of item.history) {
			emit(
				EVENT_TYPES.itemReviewed,
				{ itemId: item.id, at: entry.at, grade: entry.grade },
				entry.at
			);
		}
	}

	for (const row of state.pool) {
		const { generatedAt, timesServed, lastServedAt, reported, topic, ...challenge } = row;
		emit(
			EVENT_TYPES.challengeAdded,
			{
				challenge: challenge as SyncPayloads['challenge-added']['challenge'],
				generatedAt,
				topic
			},
			generatedAt
		);
		const servedAt = lastServedAt ?? generatedAt;
		for (let i = 0; i < timesServed; i++) {
			emit(EVENT_TYPES.challengeServed, { challengeId: row.id }, servedAt);
		}
		if (reported) {
			emit(EVENT_TYPES.challengeReported, { challengeId: row.id }, servedAt);
		}
	}

	for (const result of state.results) emit(EVENT_TYPES.resultLogged, result, result.at);

	if (state.profile) {
		emit(EVENT_TYPES.profileUpdated, state.profile, state.profile.createdAt);
	}

	return events.sort(
		(a, b) => a.at - b.at || a.device.localeCompare(b.device) || a.id.localeCompare(b.id)
	);
}

/**
 * Runs genesis against the real database, once. Returns how many events were
 * enqueued (`0` if it had already run).
 *
 * Thin by design — the repository owns the transaction and the once-only flag,
 * {@link synthesizeGenesis} owns everything worth testing. Slice 3 calls this
 * when sync is first configured.
 */
export async function runGenesis(): Promise<number> {
	const deviceId = getDeviceId();
	return seedOutbox((state) => synthesizeGenesis(state, deviceId, newUuid));
}
