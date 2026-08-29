/**
 * Carrying a pre-LiveStore learner across: the Dexie database becomes the
 * events that would have produced it.
 *
 * This is `sync/genesis.ts`'s idea a second time — a device that has been
 * learning for months back-dates the log it never wrote — and the same split:
 * {@link migrationEvents} is pure and holds everything worth testing,
 * {@link runDexieMigration} only reads a database and commits.
 *
 * Three things differ from genesis, each because the target differs.
 *
 * ## Dependency order, not `(at, device, id)` order
 *
 * Genesis sorted its output by `(at, device, id)` because `sync/apply.ts`
 * folded in that order. Step 3 retired it: the eventlog *is* the order now. So
 * these events are emitted in **dependency** order — an item before its
 * reviews, a challenge before its serves and its report.
 *
 * That is not tidiness. `v1.ItemUpdated` and `v1.ChallengeReported` are
 * `UPDATE ... WHERE id = ?`, which matches nothing and silently succeeds when
 * the row is absent. Sorting by `at` would put a report before its challenge
 * whenever `lastServedAt` was not strictly greater than `generatedAt` — and a
 * reported challenge that was never served has `lastServedAt === null`, so
 * genesis stamps *both* events at `generatedAt` and the tie breaks on a random
 * UUID. Half of those reports would have been dropped. Reviews and serves are
 * immune (they insert regardless and go inert until their parent lands), which
 * is why only the two `UPDATE`-shaped rules force the ordering.
 *
 * ## Deterministic ids, not `newUuid()`
 *
 * Genesis minted a fresh UUID per event because the outbox had no dedupe. Here
 * every id is derived from the data it describes, which makes the whole
 * migration idempotent *by construction* rather than only by the flag that
 * guards it: run it twice and every insert lands on `.onConflict(...ignore)`.
 * That matters because the flag lives in `localStorage` and `localStorage` can
 * be cleared.
 *
 * ## A constant device id, not `getDeviceId()`
 *
 * A history entry that predates sync has no `device` (see `KnowledgeItem`),
 * and one has to be invented because `reviewKey` is `(itemId, at, device)`.
 * It must **not** be `getDeviceId()`: that id is itself stored in
 * `localStorage`, so a cleared profile would mint a new one, every
 * `reviewKey` would change, and a second run would insert a *duplicate* copy
 * of the learner's entire review history — doubling the FSRS fold rather than
 * being ignored by it. {@link MIGRATION_DEVICE} is a constant for that reason.
 */

import { challengeOf } from '$lib/db/database';
import type { LegacySnapshot } from '$lib/db/legacy-snapshot';
import type { Store } from '@livestore/livestore';

import { events } from './events';
import type { schema } from './schema';

/**
 * The device a pre-sync history entry is attributed to.
 *
 * Constant on purpose — see the module comment. Entries that already carry a
 * `device` keep it, so nothing recorded during the sync era is re-attributed.
 */
export const MIGRATION_DEVICE = 'dexie-migration';

/** Every event shape this migration can emit. */
type MigrationEvent =
	| ReturnType<typeof events.itemAdded>
	| ReturnType<typeof events.itemReviewed>
	| ReturnType<typeof events.challengeAdded>
	| ReturnType<typeof events.challengeServed>
	| ReturnType<typeof events.challengeReported>
	| ReturnType<typeof events.resultLogged>
	| ReturnType<typeof events.profileUpdated>;

/**
 * Builds the event log that reproduces `snapshot`.
 *
 * Pure, and deterministic in both id and order: the same database yields the
 * same events, so committing them twice changes nothing.
 *
 * Domain timestamps are the domain's own wherever it has one. The single
 * approximation is genesis's, kept deliberately: a pool row remembers only
 * `timesServed` and `lastServedAt`, so all of its synthetic serves are stamped
 * at `lastServedAt`. The *count* stays exact — that is the field the recycling
 * policy reads — and only the spacing between past serves is lost, which
 * nothing reads.
 */
export function migrationEvents(snapshot: LegacySnapshot): MigrationEvent[] {
	const out: MigrationEvent[] = [];

	// The profile first: it depends on nothing, and a learner who somehow gets
	// only the first event still lands on their own app rather than onboarding.
	if (snapshot.profile) {
		const { nativeLanguage, targetLanguage, level, interests, about, model, createdAt } =
			snapshot.profile;
		out.push(
			events.profileUpdated({
				nativeLanguage,
				targetLanguage,
				level,
				interests,
				...(about === undefined ? {} : { about }),
				model,
				createdAt
			})
		);
	}

	for (const item of snapshot.items) {
		out.push(
			events.itemAdded({
				id: item.id,
				kind: item.kind,
				term: item.term,
				meaning: item.meaning,
				...(item.romanization === undefined ? {} : { romanization: item.romanization }),
				...(item.notes === undefined ? {} : { notes: item.notes }),
				introducedAt: item.introducedAt
			})
		);

		// After the add, always: an orphan review would survive, but there is no
		// reason to rely on that when the order is ours to choose.
		for (const entry of item.history ?? []) {
			out.push(
				events.itemReviewed({
					device: entry.device ?? MIGRATION_DEVICE,
					at: entry.at,
					itemId: item.id,
					grade: entry.grade
				})
			);
		}
	}

	for (const row of snapshot.pool) {
		out.push(
			events.challengeAdded({
				challenge: challengeOf(row),
				generatedAt: row.generatedAt,
				...(row.topic === undefined ? {} : { topic: row.topic })
			})
		);

		const servedAt = row.lastServedAt ?? row.generatedAt;
		for (let i = 0; i < row.timesServed; i++) {
			out.push(
				events.challengeServed({
					eventId: `dexie:serve:${row.id}:${i}`,
					challengeId: row.id,
					at: servedAt
				})
			);
		}

		// Strictly after the add: this one is an UPDATE and would vanish silently.
		if (row.reported) out.push(events.challengeReported({ challengeId: row.id }));
	}

	snapshot.results.forEach((result, index) => {
		out.push(
			events.resultLogged({
				// `ChallengeResult` has no id of its own, so identity comes from
				// Dexie's autoincrement key; the index is only a fallback for a row
				// that somehow lacks one, and is stable because nothing writes to the
				// legacy database any more.
				eventId: `dexie:result:${result.seq ?? `i${index}`}`,
				challengeId: result.challengeId,
				verdict: result.verdict,
				answerGiven: result.answerGiven,
				at: result.at
			})
		);
	});

	return out;
}

/* -------------------------------------------------------------------------- */
/* Running it, once                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Set once the Dexie database has been carried across.
 *
 * **Device-local on purpose, and it must never become an event.** A synced
 * "migration done" marker would reach the learner's *other* device, which has
 * its own un-migrated Dexie database; that device would see the flag, skip its
 * own migration, and silently lose everything it learned before the upgrade.
 * The thing being recorded is a fact about this browser's storage, not about
 * the learner's data, so it belongs where the other device-local facts live
 * (`db/settings.ts`, `sync/config.ts`, `ui/prefs.ts`).
 */
const MIGRATED_KEY = 'll.dexieMigrated';

function alreadyMigrated(): boolean {
	try {
		return localStorage.getItem(MIGRATED_KEY) !== null;
	} catch {
		// Private-mode or storage-disabled browsers throw on access. Falling
		// through to "not migrated" is safe: the events are idempotent.
		return false;
	}
}

function markMigrated(): void {
	try {
		localStorage.setItem(MIGRATED_KEY, String(Date.now()));
	} catch {
		/* ignore: storage unavailable or full */
	}
}

/**
 * Migrates the legacy database into `store`, at most once per browser.
 *
 * Returns the number of events committed — `0` when there was nothing to do,
 * which is the normal case for everyone who onboarded after the migration.
 *
 * Never throws. A learner whose IndexedDB is blocked or corrupt must still get
 * an app: failing here would take the whole boot down (see {@link storeReady},
 * which awaits this), and the cost of a silent failure is bounded because the
 * Dexie data is left intact for a later attempt.
 */
export async function runDexieMigration(store: Store<typeof schema>): Promise<number> {
	if (alreadyMigrated()) return 0;

	try {
		const [{ readLegacySnapshot, isEmptySnapshot }] = await Promise.all([
			import('$lib/db/legacy-snapshot')
		]);
		const snapshot = await readLegacySnapshot();

		if (isEmptySnapshot(snapshot)) {
			// Nothing to carry: mark it anyway so a fresh install stops paying for
			// this read on every boot.
			markMigrated();
			return 0;
		}

		const pending = migrationEvents(snapshot);
		for (const event of pending) store.commit(event);

		// Only after the commits land. If the tab dies mid-migration the flag
		// stays unset and the next boot redoes it — which the deterministic ids
		// make harmless.
		markMigrated();
		return pending.length;
	} catch {
		// Leave the flag unset so a later boot can try again.
		return 0;
	}
}
