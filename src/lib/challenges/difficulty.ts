/**
 * How hard a challenge actually is, 0..1, on the same axis as `wordStrength` and
 * `$lib/session/progression`'s ladder — so the planner can ask "which of these
 * bearable challenges best matches how strong this word already is" instead of
 * only "which of these can this word bear at all".
 *
 * Two facts have to compose without letting the finer one override the
 * coarser one. `demand` (`./demand`) is the fact that already gates *serving*:
 * a word that cannot bear free production must never be handed one merely
 * because its structural fields happen to read easy. So `difficultyOf` is
 * built in two layers — `demandOf` picks the challenge's tier, and each type's
 * own `difficulty` (`./types/def`) says where *within* that tier this
 * particular row sits, purely from its own stored fields (a prompt's length, a
 * word bank's size, a tile tray's size). The tiers are spans, not points, and
 * they partition `[0, 1]` in the same place `$lib/session/progression`'s
 * `demandForStrength` does, so a challenge's difficulty and the strength that
 * makes it bearable are directly comparable numbers on one scale: a
 * lower-demand challenge can never outrank a higher-demand one, however hard
 * its own fields make it read.
 *
 * Within a tier the numbers have to be comparable *between* types too — the
 * planner is choosing among the rows one word happens to have, and they are
 * rarely all the same type — which is why the length scale and the per-type
 * base offset both live in `./types/primitives` rather than in each def. See
 * `StoredTypeBehaviour.difficulty`.
 *
 * What the caller compares this against is the *centre of the word's level
 * band* (`$lib/session/progression`'s `levelBandCentre`), not the word's raw
 * `wordStrength`: a raw target sits above the middle of its own band for half
 * of every band, and a target above the middle of a tier always selects the
 * tier's hardest row.
 *
 * Dispatched through the stored-type registry exactly like `demandOf`, so a
 * type with no `difficulty` fails `pnpm check` at the registry rather than
 * defaulting to some arbitrary number.
 */

import type { Challenge } from '$lib/types';
import type { Demand } from './demand';
import { demandOf } from './demand';
import { storedDefFor } from './types';

/**
 * The `[start, end)` (closed at 1) span of `wordStrength` each demand tier
 * owns. Identical to the floors `$lib/session/progression` gates *serving* on
 * (`CONSTRAINED_PRODUCTION_FLOOR` = 0.15, `FREE_PRODUCTION_FLOOR` = 0.45): tier
 * 0 is exactly level 1 of the five-rung ladder, tier 1 is levels 2-3, tier 2 is
 * levels 4-5. Restated rather than imported — `$lib/challenges` never imports
 * `$lib/session`, which is the layer built on top of it — so a change to
 * either has to keep both in view.
 */
const TIER_SPANS: Record<Demand, readonly [number, number]> = {
	0: [0, 0.15],
	1: [0.15, 0.45],
	2: [0.45, 1]
};

/**
 * How hard `challenge` is, 0..1: `demandOf`'s tier for the coarse position,
 * the type's own `difficulty` for where inside it.
 */
export function difficultyOf(challenge: Challenge): number {
	const tier = demandOf(challenge);
	const [start, end] = TIER_SPANS[tier];
	const within = Math.min(1, Math.max(0, storedDefFor(challenge).difficulty(challenge)));
	return start + within * (end - start);
}
