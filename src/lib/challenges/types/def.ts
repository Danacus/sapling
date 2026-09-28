/**
 * The contract one *stored* challenge type has to satisfy on this side of the
 * seam: how the session treats it (`reviewsSrs`, `pooled`) and the five
 * presentation facts the feedback banner and the TTS warm-up ask of every
 * challenge — *what was the right answer* (`correctAnswerText`), *is that
 * answer in the target language* (`answerIsTargetLanguage`), *what is its
 * Latin reading* (`answerReading`), *what should the learner hear*
 * (`spokenAnswerFor`), *what might it say out loud at all* (`audioTexts`).
 *
 * Its shape, grading, demand and difficulty are Rust's
 * (`crates/sapling-challenges`), whose exhaustive `match`es fail to compile
 * for a member with no rule. The union is generated from Rust, and the registry
 * here is a mapped type over `ChallengeType` — so a new member is a `pnpm
 * check` error at the registry, naming the type that has no def, before it can
 * render blank.
 *
 * Defs are leaves: they import `$lib/types` and their own `./def`, nothing
 * else. Nothing here touches Svelte, the DB or the learner's preferences: a
 * romanization toggle is the *caller's* question, so
 * {@link StoredTypeBehaviour.answerReading} reports what the challenge has and
 * the banner decides whether to show it.
 */

import type { Challenge, ChallengeType } from '$lib/types';

/** The union member tagged `T`. */
export type ChallengeOf<T extends ChallengeType> = Extract<Challenge, { type: T }>;

/**
 * The half of a def the dispatchers call.
 *
 * Split out from {@link StoredTypeDef} so `../display` can hold a
 * def whose methods take the whole union: every member is written as a *method*
 * rather than a function-typed property, which is what makes
 * `StoredTypeDef<ClozeChallenge>` assignable to `StoredTypeBehaviour<Challenge>`
 * without a cast. That is sound here for a reason the compiler cannot see — the
 * only way to reach a def is `STORED_TYPE_DEFS[challenge.type]`, which keys the
 * def on the very discriminant the challenge carries.
 */
export interface StoredTypeBehaviour<C extends Challenge> {
	/**
	 * Whether answering this challenge feeds SRS: a verdict here becomes reviews
	 * on the items it cites.
	 *
	 * True of every generated type, and false for the one locally-built type,
	 * `match-pairs` — a recognition warm-up assembled from words the learner
	 * already has, where moving a card would inflate stability for a word that
	 * was never actually recalled. The session reads this fact instead of naming
	 * the type: `applyResult` skips the per-item review, `amendResult` and
	 * `applyOverturn` no-op, the session screen logs no item ids, and no Skip is
	 * offered. Part of the contract, not defaulted, so the registry's mapped type
	 * makes a new type answer the question.
	 */
	readonly reviewsSrs: boolean;
	/**
	 * Whether challenges of this type are persistent pool rows — the thing
	 * `reportChallenge` flags and the session plans from. True of every generated
	 * type; false for `match-pairs`, which is built in the browser and never
	 * written to the log.
	 *
	 * A separate field from {@link reviewsSrs} because they are separate
	 * questions — a pooled row need not be an SRS review — even though every type
	 * currently answers them the same way.
	 */
	readonly pooled: boolean;
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
 * One stored challenge type, as this side presents it.
 *
 * @typeParam C The union member this def handles — what every method above
 * narrows to.
 */
export interface StoredTypeDef<C extends Challenge> extends StoredTypeBehaviour<C> {
	/** The discriminator the registry keys this def by. */
	readonly type: C['type'];
}

/**
 * Every stored type, by discriminator — the shape `./index`'s registry is
 * checked against.
 *
 * A mapped type over `ChallengeType`, so it is *total* by construction: add a
 * member to the union in Rust and the registry object stops typechecking until
 * it has a def, with the missing key named in the error.
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
