/**
 * The wire-type registry: the one place that knows how many challenge types
 * there are.
 *
 * {@link WIRE_TYPE_DEFS} is ordered, and the order is load-bearing three times
 * over — it is the order the types are listed in for the model (both in the
 * prompt's `Types:` block and in the corrective retry), the order the
 * escalation prompt glosses the tile-based shapes in, and the order of
 * {@link generatedChallengeSchema}'s union, which is *built* from it.
 *
 * That last one is the point of this module. The union is not a second list to
 * keep in step with the array below; it is a projection of it, so a def that is
 * not registered here is not a wire type at all — the model is never told about
 * it, no completion can parse into it, and `pnpm check` says so at the one place
 * that tried to use it.
 *
 * **Adding a wire type**: write `./<type>.ts` — schema, `promptSpec`,
 * `correctiveSpec`, `resolve`, `fixtures`, plus `rulesSpec`/`escalationSpec` if
 * it needs them — and list it below. Everything downstream (the prompt, the
 * union, the JSON schema sent to OpenRouter, the resolver dispatch, the
 * escalation gloss, the mock lesson) follows from those two edits. The only
 * hand-written mentions left are the cross-type rules in `../generate`'s
 * `Rules:` block, which by definition name more than one type.
 */

import { z } from 'zod';
import { clozeDef } from './cloze';
import { produceMcDef } from './produce-mc';
import { recognizeMcDef } from './recognize-mc';
import { spotErrorDef } from './spot-error';
import { translateToNativeDef } from './translate-to-native';
import { translateToTargetDef } from './translate-to-target';
import { wordOrderDef } from './word-order';

import type { SchemasOf, WithOptionalSpecs } from './def';

export type {
	ChallengeBase,
	Fixture,
	FixtureScenario,
	OptionalSpecs,
	ResolveContext,
	SchemasOf,
	WirePayload,
	WithOptionalSpecs,
	WireTypeDef,
	WireTypeFixtures
} from './def';
export { FIXTURE_SCENARIOS } from './def';
export { clozePartSchema, itemRefSchema, targetTextSchema } from './primitives';
export type { TargetText } from './primitives';
export {
	clozeDef,
	produceMcDef,
	recognizeMcDef,
	spotErrorDef,
	translateToNativeDef,
	translateToTargetDef,
	wordOrderDef
};
export { generatedClozeSchema } from './cloze';
export type { GeneratedCloze } from './cloze';
export { generatedProduceMcSchema } from './produce-mc';
export type { GeneratedProduceMc } from './produce-mc';
export { generatedRecognizeMcSchema } from './recognize-mc';
export type { GeneratedRecognizeMc } from './recognize-mc';
export { generatedSpotErrorSchema } from './spot-error';
export type { GeneratedSpotError } from './spot-error';
export { generatedTranslateToNativeSchema } from './translate-to-native';
export type { GeneratedTranslateToNative } from './translate-to-native';
export { generatedTranslateToTargetSchema } from './translate-to-target';
export type { GeneratedTranslateToTarget } from './translate-to-target';
export { generatedWordOrderSchema } from './word-order';
export type { GeneratedWordOrder } from './word-order';

const REGISTRY = [
	recognizeMcDef,
	produceMcDef,
	clozeDef,
	translateToTargetDef,
	translateToNativeDef,
	wordOrderDef,
	spotErrorDef
] as const;

/**
 * Every wire type, in the order the model is shown them.
 *
 * Typed as the raw tuple intersected with {@link OptionalSpecs}: each def keeps
 * its own precise type (the union below is projected from these) while
 * `rulesSpec` and `escalationSpec` read as `string | undefined` on every member,
 * including the ones that do not carry them.
 */
export const WIRE_TYPE_DEFS: WithOptionalSpecs<typeof REGISTRY> = REGISTRY;

/** Any def, whichever payload it handles. */
export type AnyWireTypeDef = (typeof WIRE_TYPE_DEFS)[number];

/**
 * The registry's schemas as a *tuple*, which is what `z.discriminatedUnion`
 * needs: it infers the union member-by-member, and an ordinary
 * `WIRE_TYPE_DEFS.map(...)` hands it a widened `ZodType[]` that has already
 * forgotten which literal each member pins. {@link SchemasOf} projects the tuple
 * element-wise, so this stays a view of the array above rather than a second
 * list — the cast only restores at the type level what `.map` erased.
 */
type WireSchemas = SchemasOf<typeof WIRE_TYPE_DEFS>;

/**
 * The wire format the model is asked to produce, as one discriminated union.
 *
 * Re-exported from `../schemas`, which is the façade the rest of the app imports
 * from; it lives here because this is where membership is decided.
 */
export const generatedChallengeSchema = z.discriminatedUnion(
	'type',
	WIRE_TYPE_DEFS.map((def) => def.schema) as unknown as WireSchemas
);

export type GeneratedChallenge = z.infer<typeof generatedChallengeSchema>;

/** The discriminator of any wire type. */
export type WireType = GeneratedChallenge['type'];

// Parity between the registry and the union it dispatches over. Now true by
// construction — the union is projected from the array — so this asserts the
// projection itself did not lose a member, and keeps the runtime `default:`
// guard in `resolveBatch` unreachable rather than merely unlikely.
type SameKeys<A extends string, B extends string> = [Exclude<A, B> | Exclude<B, A>] extends [never]
	? true
	: false;
const _registryParity: SameKeys<AnyWireTypeDef['type'], WireType> = true;
void _registryParity;

/**
 * Lookup by discriminator, for the resolver's dispatch. Built from
 * {@link WIRE_TYPE_DEFS} so the array stays the single source of truth for
 * membership.
 */
export const byType: ReadonlyMap<WireType, AnyWireTypeDef> = new Map(
	WIRE_TYPE_DEFS.map((def) => [def.type, def] as const)
);
