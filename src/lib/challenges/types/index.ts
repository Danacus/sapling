/**
 * The stored-type registry: the one place that knows how many challenge types
 * the app holds.
 *
 * {@link STORED_TYPE_DEFS} is keyed by `ChallengeType` and typed as a mapped type
 * over it, so it is *total* by construction — add a member to the `Challenge`
 * union in `$lib/types` and this object stops typechecking until it has a def,
 * with the missing key named in the error. That is the guard the four
 * presentation `switch`es and the grading `switch` used to provide between them,
 * except it now fires once, in one file, for every fact at once.
 *
 * Everything downstream is a projection of this object: `$lib/llm/schemas`
 * composes `challengeSchema` out of {@link storedChallengeSchemas}, `../display`
 * and `../check` dispatch through {@link storedDefFor}. None of them names a
 * type.
 *
 * **Adding a stored type**: write `./<type>.ts` — `schema`, `check`, `demand` and
 * the four presentation methods — and list it below, in {@link STORED_TYPE_ORDER}
 * too. See
 * `./def` for the contract and the CLAUDE.md checklist for the wire and UI edits
 * that go with it.
 */

import type { Challenge, ChallengeType } from '$lib/types';
import { clozeStoredDef } from './cloze';
import type { StoredTypeBehaviour, StoredTypeRegistry } from './def';
import { unhandledChallenge } from './def';
import { matchPairsStoredDef } from './match-pairs';
import { multipleChoiceStoredDef } from './multiple-choice';
import { spotErrorStoredDef } from './spot-error';
import { typedTranslationStoredDef } from './typed-translation';
import { wordOrderStoredDef } from './word-order';

export type {
	ChallengeOf,
	Demand,
	StoredTypeBehaviour,
	StoredTypeDef,
	StoredTypeRegistry
} from './def';
export { unhandledChallenge };

export { clozeChallengeSchema } from './cloze';
export { matchPairsChallengeSchema } from './match-pairs';
export { multipleChoiceChallengeSchema } from './multiple-choice';
export { spotErrorChallengeSchema } from './spot-error';
export { typedTranslationChallengeSchema } from './typed-translation';
export { wordOrderChallengeSchema } from './word-order';
export { directionSchema, nonEmpty, storedBase } from './primitives';
export {
	clozeStoredDef,
	matchPairsStoredDef,
	multipleChoiceStoredDef,
	spotErrorStoredDef,
	typedTranslationStoredDef,
	wordOrderStoredDef
};

const REGISTRY = {
	'multiple-choice': multipleChoiceStoredDef,
	cloze: clozeStoredDef,
	'typed-translation': typedTranslationStoredDef,
	'match-pairs': matchPairsStoredDef,
	'word-order': wordOrderStoredDef,
	'spot-error': spotErrorStoredDef
} satisfies StoredTypeRegistry;

/**
 * Every stored challenge type, by discriminator.
 *
 * Written with `satisfies` rather than a type annotation so each def keeps its
 * own precise type — a widened `StoredTypeDef` would already have forgotten
 * which literal its schema pins, and {@link storedChallengeSchemas} could not be
 * projected from it.
 */
export const STORED_TYPE_DEFS = REGISTRY;

/** Any def, whichever union member it handles. */
export type AnyStoredTypeDef = (typeof STORED_TYPE_DEFS)[ChallengeType];

/**
 * The order the members appear in `challengeSchema`'s union.
 *
 * A second list only in the sense that TypeScript cannot read an object's key
 * order: the parity check below makes it cover exactly the same types as the
 * registry, so it can go stale in order but never in membership. Order itself is
 * cosmetic here (the union is discriminated, so parse order changes nothing),
 * which is why the tuple is pinned rather than derived — it keeps the union the
 * shape it has always had.
 */
export const STORED_TYPE_ORDER = [
	'multiple-choice',
	'cloze',
	'typed-translation',
	'match-pairs',
	'word-order',
	'spot-error'
] as const;

type StoredTypeOrder = typeof STORED_TYPE_ORDER;

// Parity between the registry and the order the union is composed in: a type
// added to one and not the other fails here rather than in the shape of the
// union it silently left out.
type SameKeys<A extends string, B extends string> = [Exclude<A, B> | Exclude<B, A>] extends [never]
	? true
	: false;
const _orderParity: SameKeys<StoredTypeOrder[number], ChallengeType> = true;
void _orderParity;

/**
 * The registry's schemas as a *tuple*, in {@link STORED_TYPE_ORDER}, which is what
 * `z.discriminatedUnion` needs: it infers the union member-by-member, and a
 * `.map(...)` over the registry hands it a widened `ZodType[]` that has already
 * forgotten which literal each member pins — restoring that cost a mapped-type
 * projection and an `as unknown as` cast, more machinery than these six lines.
 * Spelled out instead: membership cannot drift (`_orderParity` above and the
 * mapped registry type), and `registry.test.ts` pins order and member identity.
 *
 * `$lib/llm/schemas` wraps this into `challengeSchema`; nothing else should need
 * it.
 */
export const storedChallengeSchemas = [
	multipleChoiceStoredDef.schema,
	clozeStoredDef.schema,
	typedTranslationStoredDef.schema,
	matchPairsStoredDef.schema,
	wordOrderStoredDef.schema,
	spotErrorStoredDef.schema
] as const;

/**
 * The def for a challenge, with its methods widened to the whole union.
 *
 * The one lookup every dispatcher goes through. Sound because the key *is* the
 * challenge's own discriminant: `STORED_TYPE_DEFS[c.type]` is by definition the
 * def for `c`'s type, a correlation TypeScript cannot express but
 * {@link StoredTypeBehaviour}'s method-style declarations make it accept.
 *
 * The falsy branch is unreachable through the type system and is there for the
 * row that arrives from outside it — a challenge synced from a build that knew
 * more types than this one. It throws rather than rendering blank.
 */
export function storedDefFor(challenge: Challenge): StoredTypeBehaviour<Challenge> {
	const def = STORED_TYPE_DEFS[challenge.type];
	if (!def) unhandledChallenge(challenge as never);
	return def;
}
