/**
 * The stored-type registry: the one place on this side that knows how many
 * challenge types the app holds.
 *
 * {@link STORED_TYPE_DEFS} is keyed by `ChallengeType` and typed as a mapped type
 * over it, so it is *total* by construction — a member added to the union in
 * Rust (`crates/sapling-challenges`' `challenge.rs`) makes this object stop
 * typechecking until it has a def, with the missing key named in the error.
 * `../display` and the session dispatch through {@link storedDefFor}; none of
 * them names a type.
 *
 * **Adding a stored type**: write `./<type>.ts` — the session facts and the
 * five presentation methods — and list it below. See `./def` for the contract
 * and the `add-challenge-type` skill for the Rust and UI edits that go with it.
 */

import type { Challenge } from '$lib/types';
import { clozeStoredDef } from './cloze';
import type { StoredTypeBehaviour, StoredTypeRegistry } from './def';
import { unhandledChallenge } from './def';
import { matchPairsStoredDef } from './match-pairs';
import { multiClozeStoredDef } from './multi-cloze';
import { multipleChoiceStoredDef } from './multiple-choice';
import { spotErrorStoredDef } from './spot-error';
import { typedTranslationStoredDef } from './typed-translation';
import { wordOrderStoredDef } from './word-order';

export type { ChallengeOf, StoredTypeBehaviour, StoredTypeDef, StoredTypeRegistry } from './def';
export { unhandledChallenge };

/** Every stored challenge type, by discriminator. */
export const STORED_TYPE_DEFS = {
	'multiple-choice': multipleChoiceStoredDef,
	cloze: clozeStoredDef,
	'typed-translation': typedTranslationStoredDef,
	'match-pairs': matchPairsStoredDef,
	'multi-cloze': multiClozeStoredDef,
	'word-order': wordOrderStoredDef,
	'spot-error': spotErrorStoredDef
} satisfies StoredTypeRegistry;

/**
 * The def for a challenge, with its methods widened to the whole union.
 *
 * Sound because the key *is* the challenge's own discriminant. The falsy
 * branch is for a row from outside the type system — synced from a build that
 * knew more types than this one — and throws rather than rendering blank.
 */
export function storedDefFor(challenge: Challenge): StoredTypeBehaviour<Challenge> {
	const def = STORED_TYPE_DEFS[challenge.type];
	if (!def) unhandledChallenge(challenge as never);
	return def;
}
