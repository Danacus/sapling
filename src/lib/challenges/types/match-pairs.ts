/**
 * `match-pairs` — pair each term with its counterpart.
 *
 * The odd one out, and deliberately so: it is assembled locally at zero cost (no
 * wire type generates it), it is graded a tap at a time in the component rather
 * than from one answer string, and it has no single "the answer" to print, read
 * or speak. Every *answer* fact here is therefore the empty one — which is
 * exactly what the banner wants: an empty `correctAnswerText` means "print no
 * answer line at all".
 *
 * `audioTexts` is the exception, and for the same reason: with no one answer,
 * what the round speaks is decided a tap at a time, so it warms the whole
 * left-hand column rather than any single phrase.
 */

import { z } from 'zod';
import type { MatchPairsChallenge } from '$lib/types';
import { normalize } from '$lib/validate';
import type { StoredTypeDef } from './def';
import { clamp01, nonEmpty, storedBase } from './primitives';

/**
 * Pair count spanning the full 0..1 range. `$lib/llm/generate` builds three to
 * six pairs off the learner's ladder rung (`MATCH_PAIRS_LADDER`), or four to
 * five when it is given no rung — both comfortably inside this span, which is
 * the point: a ladder reaching past `MOST_PAIRS` would peg its top rungs to the
 * same stored difficulty.
 */
const FEWEST_PAIRS = 2;
const MOST_PAIRS = 6;

export const matchPairsChallengeSchema = z.object({
	type: z.literal('match-pairs'),
	pairs: z
		.array(
			z.object({
				a: nonEmpty,
				b: nonEmpty,
				aRom: z.string().optional(),
				bRom: z.string().optional()
			})
		)
		.min(2),
	...storedBase
});

export const matchPairsStoredDef = {
	type: 'match-pairs',
	schema: matchPairsChallengeSchema,

	check(challenge, answerGiven) {
		// Match-pairs is normally graded interactively in the UI (each tap
		// resolves one pair), not via a single free-text answer. This stays
		// gradeable by accepting an "a::b" / "a|b" encoding of one resolved pair,
		// matched against the challenge's pairs.
		const parts = answerGiven.split(/::|\|/).map((p) => p.trim());
		if (parts.length !== 2) return 'wrong';
		const [a, b] = parts;
		const hit = challenge.pairs.some(
			(pair) => normalize(a) === normalize(pair.a) && normalize(b) === normalize(pair.b)
		);
		return hit ? 'correct' : 'wrong';
	},

	// Recognition, and the easiest kind: both halves of every pair are on screen
	// and the learner only has to join them up. Academic in practice — match
	// rounds are built locally and never pooled, so no planner ever asks — but the
	// registry is total by construction and an honest answer costs one line.
	demand() {
		return 0;
	},

	// Academic, like `demand` above: match rounds are built locally and never
	// pooled, so no planner ever asks. Pair count is the one knob it has — not a
	// prose length, so it keeps its own scale — and the type carries no base
	// offset: joining pairs that are all on screen is the recognition tier's
	// floor, alongside `multiple-choice`.
	difficulty(challenge) {
		return clamp01((challenge.pairs.length - FEWEST_PAIRS) / (MOST_PAIRS - FEWEST_PAIRS));
	},

	correctAnswerText() {
		return '';
	},

	answerIsTargetLanguage() {
		return false;
	},

	answerReading() {
		return undefined;
	},

	spokenAnswerFor() {
		return '';
	},

	// The one place this type is not silent, and it is the noisiest type there
	// is: the left column is the target language, so every left-hand tap reads
	// its tile aloud (see `MatchPairs.svelte`). Which tile the learner reaches
	// for is unknowable, so the whole column is warmed, in tile order.
	// Deduplicated because a term can legitimately appear in two pairs.
	audioTexts(challenge) {
		const left = challenge.pairs.map((pair) => pair.a.trim()).filter((text) => text !== '');
		return [...new Set(left)];
	}
} satisfies StoredTypeDef<MatchPairsChallenge>;
