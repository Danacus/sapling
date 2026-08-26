/**
 * The contract one *stored* challenge type has to satisfy.
 *
 * A `StoredTypeDef` is the whole of what the app knows about a member of the
 * `Challenge` union once it has been generated: the zod schema that validates it
 * (`schema`), how a learner's answer to it is graded (`check`), how much it asks
 * of the learner (`demand`), and the five presentation facts the feedback banner
 * and the TTS warm-up ask of every challenge — *what was the right answer*
 * (`correctAnswerText`), *is that answer in the target language*
 * (`answerIsTargetLanguage`), *what is its Latin reading* (`answerReading`),
 * *what should the learner hear* (`spokenAnswerFor`), *what might it say out
 * loud at all* (`audioTexts`).
 *
 * Those facts used to live in three files and eight `switch`es. Adding a
 * type meant finding all of them, and the compiler only checked some. Now they
 * are one object per type, listed in `./index`, and the registry is a mapped type
 * over `ChallengeType` — so a seventh member of the union is a `pnpm check`
 * error at the registry, naming the type that has no def, before it can render
 * blank or grade wrong.
 *
 * Defs are leaves. They may import zod, `./primitives`, `$lib/types` and
 * `$lib/validate` (the string matchers, which know nothing about challenges),
 * and must import neither `../display` nor anything under `$lib/llm` — both are
 * *downstream*: `$lib/llm/schemas` composes `challengeSchema` out of these, and
 * `../display` dispatches through them, so an import either way would close a
 * cycle. Nothing here touches Svelte, the DB or the learner's preferences: a
 * romanization toggle is the *caller's* question, so {@link
 * StoredTypeBehaviour.answerReading} reports what the challenge has and the
 * banner decides whether to show it.
 */

import type { z } from 'zod';
import type { Challenge, ChallengeType, Verdict } from '$lib/types';

/** The union member tagged `T`. */
export type ChallengeOf<T extends ChallengeType> = Extract<Challenge, { type: T }>;

/**
 * How much productive recall a challenge asks of its words.
 *
 * An ordinal, not a score: `0 < 1 < 2` is the only arithmetic anyone should do
 * with it, and the one comparison `$lib/session/progression` makes is "is this
 * tier at or below what the weakest word can bear".
 */
export type Demand = 0 | 1 | 2;

/**
 * The half of a def the dispatchers call.
 *
 * Split out from {@link StoredTypeDef} so `../display` and `../check` can hold a
 * def whose methods take the whole union: every member is written as a *method*
 * rather than a function-typed property, which is what makes
 * `StoredTypeDef<ClozeChallenge>` assignable to `StoredTypeBehaviour<Challenge>`
 * without a cast. That is sound here for a reason the compiler cannot see — the
 * only way to reach a def is `STORED_TYPE_DEFS[challenge.type]`, which keys the
 * def on the very discriminant the challenge carries.
 */
export interface StoredTypeBehaviour<C extends Challenge> {
	/**
	 * Grades an answer to this type.
	 *
	 * Every type is gradeable from a single string, including the tapped ones:
	 * the component reports what the learner assembled (the word-order sentence,
	 * the spot-error token, an `"a::b"` pair) and the def compares it. Whether
	 * near-misses earn `'almost'` is per type — a typed answer was spelled, a
	 * tapped one was chosen from a closed set.
	 */
	check(challenge: C, answerGiven: string): Verdict;
	/**
	 * How much productive recall this challenge asks of its words, 0..2:
	 * 0 recognition (read/choose), 1 constrained production (assemble from
	 * given material), 2 free production (produce from nothing).
	 * Session planning gates 1 and 2 behind word strength; see
	 * `$lib/session/progression`.
	 *
	 * A *fact about the question*, deliberately not a factor in
	 * {@link check}: grading stays type-blind, because a verdict is FSRS's
	 * evidence about the word and fudging it per type would corrupt the
	 * schedule. What demand shapes is which question gets asked, never what
	 * the answer to it is worth.
	 *
	 * Takes the whole challenge rather than being a constant per type because
	 * two types straddle a tier: a cloze with a word bank is a choice and one
	 * without is free recall, and typed translation is production in one
	 * direction and comprehension in the other.
	 */
	demand(challenge: C): Demand;
	/**
	 * What the feedback banner tells the learner they should have answered.
	 *
	 * The canonical form in every case — `acceptedAnswers[0]`, the option at
	 * `correctIndex`, the assembled word-order sentence — never a romanized
	 * variant and never the learner's own near-miss (the banner shows
	 * `closestAccepted` separately, and knows to prefer it). `''` means "print no
	 * answer line at all".
	 */
	correctAnswerText(challenge: C): string;
	/**
	 * Whether {@link correctAnswerText} is a target-language string.
	 *
	 * Drives both the romanization line and (via the banner) whether reading the
	 * answer back is worth anything: hearing your own native language read aloud
	 * teaches nothing.
	 */
	answerIsTargetLanguage(challenge: C): boolean;
	/**
	 * The Latin reading of {@link correctAnswerText}, when the challenge carries
	 * one — the moment a learner is told a word they could not produce is exactly
	 * when they need to know how to say it.
	 *
	 * Reports the field and nothing else: the "is this even a target-language
	 * answer" gate is shared, so `../display` applies it once before dispatching
	 * here. `undefined` for Latin-script targets and for rows generated before the
	 * reading fields existed.
	 */
	answerReading(challenge: C): string | undefined;
	/**
	 * The canonical target-language audio for this challenge's answer, or `''`
	 * when there is nothing worth hearing.
	 *
	 * Always the canonical script form — never a romanized variant: TTS reads
	 * Latin letters as Latin letters. Most types return `''` when the answer is in
	 * the learner's own language; the ones whose *sentence* is target-language
	 * whichever way they are exercised say so themselves, which is why the
	 * direction gate lives in the defs and not around them.
	 */
	spokenAnswerFor(challenge: C): string;
	/**
	 * Every target-language phrase this challenge may speak while it is on
	 * screen, in the order it is likely to want them — `[]` when it never makes
	 * a sound.
	 *
	 * The union of what the *component* can hand `speak()` (the prompt behind the
	 * header's speaker button, a match tile read out on selection) and what the
	 * feedback banner plays afterwards ({@link spokenAnswerFor}), because the
	 * session screen pre-synthesizes this list the moment a challenge is served
	 * and Kokoro renders one phrase at a time. A phrase missing from here is not
	 * a bug the learner can see — it simply arrives a second or two late — but a
	 * phrase in the *wrong form* is wasted work, so the same rule as
	 * `spokenAnswerFor` holds: always the canonical script, never a romanized
	 * variant. Deduplicated, since a warm of the same string twice is a wasted
	 * pass over the cache.
	 *
	 * A def that shares a phrase with its own `spokenAnswerFor` computes it once,
	 * in one place in the module: a drift between the warmed string and the
	 * spoken one turns every warm into a silent miss.
	 */
	audioTexts(challenge: C): string[];
}

/**
 * One stored challenge type, schema through presentation.
 *
 * @typeParam C The union member this def handles — what its `schema` parses and
 * what every method above narrows to.
 */
export interface StoredTypeDef<C extends Challenge> extends StoredTypeBehaviour<C> {
	/** The discriminator, identical to the one `schema` pins. */
	readonly type: C['type'];
	/**
	 * This type's zod member. It lives here, not in `$lib/llm/schemas`: the
	 * `challengeSchema` union over there is built by projecting this field across
	 * the registry, so listing a def in `./index` is the whole of adding a member
	 * to it.
	 */
	readonly schema: z.ZodType<C>;
}

/**
 * Every stored type, by discriminator — the shape `./index`'s registry is
 * checked against.
 *
 * A mapped type over `ChallengeType`, so it is *total* by construction: add a
 * member to the `Challenge` union in `$lib/types` and the registry object stops
 * typechecking until it has a def, with the missing key named in the error.
 */
export type StoredTypeRegistry = {
	readonly [T in ChallengeType]: StoredTypeDef<ChallengeOf<T>>;
};

/**
 * Guard for a challenge whose type this build does not know.
 *
 * Unreachable through the registry, which TypeScript checks first: the argument
 * is `never`, so a union member with no def is a type error at every call site.
 * The throw is the belt to that pair of braces — a stored row carrying a type
 * this build has never heard of (a downgrade after a sync, say) is a bug worth
 * surfacing loudly rather than rendering as a blank answer.
 */
export function unhandledChallenge(challenge: never): never {
	const type = (challenge as { type?: unknown } | null)?.type;
	throw new Error(`Unhandled challenge type: ${String(type)}`);
}
