/**
 * The one Fisher-Yates shuffle the app shares.
 *
 * It used to live in `$lib/llm/resolve-helpers` because the wire resolvers were
 * its first callers. It is not an LLM concern, though: the local match-pairs
 * builder (`$lib/challenges/local/match-pairs`) needs the same shuffle to order
 * a round, and it must not reach into `$lib/llm` for a zero-token helper. One
 * implementation, no drift.
 */

/** Fisher-Yates over a copy; `rng` is injectable so shuffles can be replayed. */
export function shuffled<T>(values: readonly T[], rng: () => number): T[] {
	const out = [...values];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
