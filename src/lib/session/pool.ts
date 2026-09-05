/**
 * What makes a pooled challenge eligible — shared by the two halves of the
 * engine that read the pool for different reasons.
 *
 * `planSession` (`./engine`) asks these questions to decide what to *play*;
 * `planTopUp` (`./topup`) asks the very same ones to decide what to *write*: a
 * want exists exactly where a word has no rested, playable challenge of a kind
 * it can bear. Keeping the predicates in one place is what keeps those two
 * answers the same — a challenge the session would decline to serve is not
 * coverage, and one it would happily serve does not need writing again.
 */

import type { ChallengeRow } from '$lib/db';
import type { KnowledgeItem } from '$lib/types';

/**
 * How long a challenge rests after being served before it may be planned again.
 *
 * The pool is recycled, but not tightly: re-seeing the exact same sentence a
 * few minutes later trains *the card* — the shape of that one prompt and the
 * answer that goes with it — rather than the word underneath. Three days is
 * long enough that the sentence has to be re-read rather than recognized, and
 * short enough that a modest pool still covers a daily habit.
 *
 * A preference, not a rule: `planSession` bends it when a word that owes a
 * review has nothing else to offer.
 */
export const RESERVE_GAP = 3 * 24 * 60 * 60 * 1000;

/**
 * True while a pooled challenge is worth playing at all.
 *
 * Absolute, unlike {@link isRested}: not flagged by the learner, and every word
 * it exercises still there. A challenge whose vocabulary was deleted grades
 * nothing and often no longer even makes sense; it is dead weight, not
 * practice. Nothing here is about *timing* — that is the negotiable half, and
 * it lives in its own predicate for exactly that reason.
 */
export function isPlayable(row: ChallengeRow, known: ReadonlySet<string>): boolean {
	if (row.reported) return false;
	if (row.itemIds.length === 0) return false;
	return row.itemIds.every((id) => known.has(id));
}

/**
 * True while a challenge is out of its {@link RESERVE_GAP} — never served, or
 * served long enough ago that the sentence has to be re-read. The preference
 * half of eligibility; see `planSession` for when it yields.
 */
export function isRested(row: ChallengeRow, now: number): boolean {
	return row.lastServedAt === null || now - row.lastServedAt >= RESERVE_GAP;
}

/**
 * Every word the learner has, as a set of ids.
 *
 * The learner's whole vocabulary participates in every session — a word added
 * yesterday and never reviewed is as eligible as one they have seen ten times,
 * because a session *is* the FSRS review of what they have. So this is not a
 * filter, and the set exists only for the lookup: {@link isPlayable} uses it to
 * check that a pooled challenge's words all still resolve.
 */
export function knownItemIds(items: readonly KnowledgeItem[]): Set<string> {
	return new Set(items.map((item) => item.id));
}
