/**
 * Cross-check: the Rust allow-list and the stored registry name the same types.
 *
 * `crates/sapling-core/src/materialize.rs`'s `CHALLENGE_TYPES` is the list the
 * materializer checks before storing a challenge. A name missing from it costs
 * one silently skipped row — the event stays in the log, the challenge never
 * reaches the pool — and only the `broad` golden fixture would notice. The two
 * lists cannot be derived from one another across the language boundary, so this
 * reads the Rust source and asserts they agree as a set, the same guard
 * `registry.test.ts` aims at the union extended to the other implementation.
 *
 * The parse is deliberately strict: if the array's shape changes so the regex no
 * longer matches, the test throws with a clear message instead of passing
 * vacuously.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STORED_TYPE_ORDER } from './index';

const TYPES_DIR = dirname(fileURLToPath(import.meta.url));
/** `src/lib/challenges/types` → the repo root. */
const REPO_ROOT = join(TYPES_DIR, '..', '..', '..', '..');
const MATERIALIZE_RS = join(REPO_ROOT, 'crates', 'sapling-core', 'src', 'materialize.rs');

/**
 * The types named by `CHALLENGE_TYPES`, and the length its declaration pins.
 *
 * Anchored on the declaration's `const … = [` and the closing `];`, so a changed
 * shape (a different container, a field added before the list) throws rather
 * than matching some unrelated string list elsewhere in the file.
 */
function parseChallengeTypes(source: string): { types: string[]; declared: number } {
	const declaration = /const\s+CHALLENGE_TYPES\s*:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/.exec(
		source
	);
	if (!declaration) {
		throw new Error(
			'could not parse CHALLENGE_TYPES from materialize.rs — has the array shape changed?'
		);
	}
	const literals = [...declaration[2].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
	if (literals.length === 0) {
		throw new Error('CHALLENGE_TYPES parsed with no string literals — check the array shape');
	}
	return { types: literals, declared: Number(declaration[1]) };
}

describe('CHALLENGE_TYPES (Rust allow-list)', () => {
	it('names exactly the stored types, and the length it declares', () => {
		const source = readFileSync(MATERIALIZE_RS, 'utf8');
		const { types, declared } = parseChallengeTypes(source);

		// Set equality, not order: the union is discriminated, so the allow-list's
		// order carries no meaning — only which names it holds.
		expect([...types].sort()).toEqual([...STORED_TYPE_ORDER].sort());
		expect(types).toHaveLength(STORED_TYPE_ORDER.length);
		// The declaration's own `[&str; N]` must count the entries it holds, so a
		// row added to the list without the count cannot slip past.
		expect(declared).toBe(types.length);
	});
});
