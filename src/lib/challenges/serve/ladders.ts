/**
 * The serve-time ladders and ceilings: how much support a challenge shows at
 * each of the five difficulty rungs, as the raw numbers the rest of
 * `serve/` looks up.
 *
 * These four used to sit beside the functions that read them in
 * `presentation.ts`. They are a leaf of their own now so `./progression` can
 * read the cloze bank ladder — it needs the rung at which the bank goes to zero
 * to reconcile a cloze's served demand — without importing `./presentation`,
 * which imports *it*. Nothing here imports anything: the numbers are the
 * contract, and both modules are written against them.
 */

/**
 * The last rung at which the native line still shows. Rung 2 is the floor
 * word-order, spot-error and cloze are first planned at
 * (`PLANNABLE_KINDS.levels`), so a learner meets each format with the
 * sentence's meaning beside it and loses it one rung later.
 */
export const HINT_CEILING_LEVEL = 2;

/** Cloze word-bank size by rung, answer included — zero at the top rung: cued recall, typed. */
export const CLOZE_BANK_LADDER = [3, 4, 5, 6, 0] as const;

/**
 * The rung at which a served cloze's word bank reads as empty — the one point
 * where `./progression`'s `servedDemand` diverges from the stored `demandOf`.
 *
 * Read from {@link CLOZE_BANK_LADDER} rather than repeated, and failing loudly
 * if the ladder ever loses its zero: a bare `findIndex` would silently return
 * `-1`, make this rung 0, and flip every banked cloze to served demand 2. The
 * invariant — exactly one zero rung — is the ladder's, and is pinned by
 * `presentation.test.ts`.
 */
export function clozeTypedLevel(): number {
	const zeros = CLOZE_BANK_LADDER.filter((size) => size === 0).length;
	if (zeros !== 1) {
		throw new Error(`CLOZE_BANK_LADDER must contain exactly one zero rung, found ${zeros}`);
	}
	return CLOZE_BANK_LADDER.indexOf(0) + 1;
}

/**
 * Multi-cloze extra distractor count by rung, beyond the row's own gaps — the
 * bank is sized relative to how many answers it has to hold, not to an
 * absolute count: a 3-gap row and a 2-gap row at the same rung differ by one
 * chip, not by whatever the stronger row's bank happens to total. Mirrors
 * {@link WORD_ORDER_DISTRACTOR_LADDER}, which is relative for the same reason.
 */
export const MULTI_CLOZE_DISTRACTOR_LADDER = [1, 1, 1, 2, 3] as const;

/** Word-order distractor tile count by rung — the sentence's own tiles are always shown. */
export const WORD_ORDER_DISTRACTOR_LADDER = [0, 0, 1, 2, 3] as const;
