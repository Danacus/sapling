/**
 * The one Fisher-Yates shuffle the app shares.
 *
 * The local match-pairs builder (`$lib/challenges/local/match-pairs`) orders a
 * round with it; the generated challenges are shuffled in Rust.
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
