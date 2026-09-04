/**
 * The contract one wire type has to satisfy.
 *
 * A `WireTypeDef` is the whole of what the generation side knows about a
 * challenge type: its zod schema, how it is described to the model
 * (`promptSpec`, `rulesSpec`), how it is re-described when a reply has to be
 * rejected (`correctiveSpec`), what a disputing learner's escalation needs told
 * about its stored shape (`escalationSpec`), how it becomes a stored `Challenge`
 * (`resolve`), and the canned examples practice mode plays (`fixtures`). Adding
 * a type is writing one of these and listing it in `./index`; no other module
 * names a type.
 *
 * Defs are leaves. They may import `./primitives`, `../resolve-helpers` and
 * `$lib/*`, and must import neither `../schemas` nor `../generate` — both are
 * *downstream*: the union, the prompt and the escalation prose are all composed
 * out of the registry, so an import either way would close a cycle.
 */

import type { z } from 'zod';
import type { Challenge, ChallengeType, Direction } from '$lib/types';

/**
 * What this wire type becomes once resolved: the stored `type` and `direction`
 * its `resolve` always writes.
 *
 * Two wire types can share a stored type — `recognize-mc` and `produce-mc` are
 * both `multiple-choice`, the two translate types are both `typed-translation` —
 * and the direction is what tells them apart, which is why both fields are here
 * and neither is optional. Declared rather than inferred because the generator
 * has to check a *reply* against the plan it asked for (`matchesSlot` in
 * `../generate`): a chunk that answered five `cloze` slots with five
 * `recognize-mc` challenges is not a chunk that came back usable, and counting
 * challenges alone could never see that.
 */
export interface StoredShape {
	readonly type: ChallengeType;
	readonly direction: Direction;
}

/**
 * The least a generated payload must be for the machinery here to work: an
 * object tagged with its own wire type. The concrete payload types are inferred
 * from each def's schema, and their union — `GeneratedChallenge` — is derived
 * from the registry rather than declared anywhere.
 */
export interface WirePayload {
	type: string;
}

/**
 * The type-agnostic half of a stored challenge, already worked out by the
 * pipeline: the minted id, the `itemIds` with their term citations resolved to
 * real item ids, and the explanation normalized to absent-or-string.
 *
 * A resolver spreads this first and then writes its own fields on top; it never
 * mints an id and never re-reads `generated.itemIds`.
 */
export interface ChallengeBase {
	id: string;
	itemIds: string[];
	explanation?: string;
}

/** Everything a resolver is allowed to depend on beyond its own payload. */
export interface ResolveContext {
	base: ChallengeBase;
	/** Injectable `[0,1)` source, so option order and tile order are replayable. */
	rng: () => number;
}

/**
 * The mock's fixture sets, one per target-language script. Both are restaurant
 * scenes so a practice lesson reads as one lesson and not a grab bag: `spanish`
 * is the Latin-script default with `"reading": null` throughout, `mandarin` the
 * same coverage with pinyin on every target-script string.
 */
export const FIXTURE_SCENARIOS = ['spanish', 'mandarin'] as const;

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

/**
 * One canned challenge, plus where it sits in its scenario.
 *
 * `order` exists because the assembled batch is ordered by *lesson*, not by
 * wire type — a scenario opens with recognition and ends on the hardest
 * production types, and each cloze sits next to the challenge it follows on
 * from. The mock sorts every def's fixtures into one list by this number, so a
 * def can place its examples anywhere in the lesson without the registry's own
 * order having to move.
 */
export interface Fixture<T> {
	/** Position in the assembled scenario batch; unique within a scenario. */
	order: number;
	challenge: T;
}

/** A def's canned examples, by scenario. */
export type WireTypeFixtures<T> = Readonly<Record<FixtureScenario, readonly Fixture<T>[]>>;

/**
 * One wire type, schema through resolver.
 *
 * @typeParam T The generated payload this def handles — what its `schema`
 * parses, and one member of the derived `GeneratedChallenge` union.
 */
export interface WireTypeDef<T extends WirePayload = WirePayload> {
	/** The discriminator, identical to the one `schema` pins. */
	readonly type: T['type'];
	/**
	 * This type's zod member. It lives here, not in `../schemas`: `./index`
	 * lists this field in `generatedChallengeSchema`'s union, and its parity
	 * check keeps that list and the registry covering the same types.
	 */
	readonly schema: z.ZodType<T>;
	/**
	 * The stored `{type, direction}` this def's {@link WireTypeDef.resolve}
	 * always produces — see {@link StoredShape}. Forgetting it fails
	 * `pnpm check`; getting it wrong fails `registry.test.ts`, which resolves
	 * every fixture and compares.
	 */
	readonly stored: StoredShape;
	/**
	 * This type's line in the prompt's `Types:` block — field list plus one
	 * inline JSON example. Every token here is paid on every batch call, so it is
	 * written to be terse, not friendly.
	 */
	readonly promptSpec: string;
	/**
	 * This type's line in the `Rules:` block, when it has one that mentions no
	 * other type. Rules that span types (segmentation, the never-swap-sides rule)
	 * stay global in `../generate` and are absent here.
	 */
	readonly rulesSpec?: string;
	/** This type's field list in the retry instruction, e.g. `cloze {before,…}`. */
	readonly correctiveSpec: string;
	/**
	 * What an escalation has to be told about this type's *stored* shape, when
	 * the JSON does not explain itself.
	 *
	 * Most stored challenges are self-describing — a `prompt` and
	 * `acceptedAnswers` need no gloss — but the tile-based ones do not say which
	 * array the learner rearranged or which index is the wrong word. Only those
	 * carry a fragment; `../escalation` splices the ones that exist into its
	 * system prompt and says nothing about the rest.
	 */
	readonly escalationSpec?: string;
	/**
	 * The canned examples practice mode plays, in the wire format — they go
	 * through the *same* parse and resolve path as a paid batch, so a fixture is
	 * a schema conformance test as much as it is content.
	 *
	 * A fixture cites its subject in `itemIds` **by term** — `'la cuenta'`, not
	 * an id, since a scenario cannot know the learner's ids. The mock binds those
	 * terms to real items before resolving; see `mock.ts`.
	 */
	readonly fixtures: WireTypeFixtures<T>;
	/**
	 * Assembles the stored challenge, or returns `null` to drop it.
	 *
	 * `null` is reserved for *structural* failures — a corruption that lands
	 * outside its sentence, both sides of the card in the target language — the
	 * cases where there is no challenge left to play. Cosmetic defects (a partial
	 * reading, a word bank that dedupes down to nothing) degrade silently
	 * instead: the batch is already paid for.
	 */
	resolve(generated: T, ctx: ResolveContext): Challenge | null;
}

/**
 * The optional specs, as keys that always exist.
 *
 * Defs are written with `satisfies`, which keeps each one's *literal* type —
 * that is what lets `./index` project the union out of the registry, since a
 * widened `z.ZodType` would already have forgotten which literal its `type`
 * pins. The cost is that a literal type has no key at all for an optional spec
 * the def did not write, so reading `def.rulesSpec` across the registry would
 * not typecheck. `./index` intersects this back in: the specs read as
 * `string | undefined` everywhere, and nothing else is widened.
 */
export type OptionalSpecs = Pick<WireTypeDef, 'rulesSpec' | 'escalationSpec'>;

/** {@link OptionalSpecs} intersected into every element of a tuple of defs. */
export type WithOptionalSpecs<T extends readonly unknown[]> = {
	readonly [K in keyof T]: T[K] & OptionalSpecs;
};
