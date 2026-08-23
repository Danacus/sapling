/**
 * Shared domain types for the whole app.
 *
 * Everything (db, srs, validate, llm, ui) depends on this module, so keep it
 * dependency-free: no imports, no runtime values other than plain type aliases.
 */

/** CEFR-ish proficiency buckets used to steer generation difficulty. */
export type Level = 'beginner' | 'elementary' | 'intermediate' | 'advanced';

/** Which way a challenge is exercised. */
export type Direction = 'toTarget' | 'toNative';

/** Grading outcome for a single answered challenge. */
export type Verdict = 'correct' | 'almost' | 'wrong';

/** The learner's configuration, captured during onboarding. */
export interface Profile {
	/** Language the learner already speaks, e.g. `'nl'` or `'English'`. */
	nativeLanguage: string;
	/** Language being learned. */
	targetLanguage: string;
	level: Level;
	/** Free-form topics used to personalize generated content. */
	interests: string[];
	/**
	 * The learner describing themselves in their own words — job, city, family,
	 * tastes, whatever they care to say. Written on the profile page and sent
	 * (capped, see `MAX_ABOUT_CHARS` in `$lib/llm`) with every generation request,
	 * so scenarios can be set in their actual life instead of a generic one.
	 * Never required: absent or blank simply personalizes nothing.
	 */
	about?: string;
	/** XP target per day; drives the streak and daily goal ring. */
	dailyGoalXp: number;
	/** OpenRouter model id, e.g. `'openai/gpt-4o-mini'`. */
	model: string;
	/** Epoch milliseconds. */
	createdAt: number;
}

/**
 * One learnable atom (a word, phrase or grammar point) tracked by the SRS.
 *
 * `fsrsCard` holds the `Card` object owned by ts-fsrs; it is typed as `unknown`
 * here so this module stays dependency-free. Cast it in `src/lib/srs/`.
 */
export interface KnowledgeItem {
	id: string;
	kind: 'vocab' | 'grammar';
	/** The item as it appears in the target language. */
	term: string;
	/** The meaning in the learner's native language. */
	meaning: string;
	/**
	 * Latin-script reading of `term`, for target languages that are not written
	 * in the Latin script (pinyin, romaji, revised romanization, ...).
	 *
	 * Absent for Latin-script languages — the generator is told to omit it, so
	 * those learners never pay tokens for a field they cannot use.
	 */
	romanization?: string;
	/** Optional usage notes, gender, conjugation hints, etc. */
	notes?: string;
	/** ts-fsrs `Card`. */
	fsrsCard: unknown;
	/** Epoch milliseconds. */
	introducedAt: number;
	/** Review log, newest last. `grade` is the ts-fsrs `Rating`. */
	history: { at: number; grade: number }[];
}

/**
 * Fields shared by every challenge variant.
 *
 * Romanization note, which applies to every `*Romanization` field below: these
 * are display-only Latin-script readings, emitted **only** when the target
 * language is not written in the Latin script. Latin-script languages omit them
 * entirely — a Spanish challenge carries no romanization key at all — so the
 * feature costs nothing for the majority case. The UI should render them as a
 * secondary line under the target-script string when present, and change
 * nothing when absent.
 */
interface ChallengeBase {
	id: string;
	direction: Direction;
	/** Shown after answering; why the answer is what it is. */
	explanation?: string;
}

/** Pick one of four options. */
export interface MultipleChoiceChallenge extends ChallengeBase {
	type: 'multiple-choice';
	prompt: string;
	/** Romanization of `prompt`, when the prompt is in the target script. */
	promptRomanization?: string;
	/**
	 * Heading shown above the prompt, e.g. "What does this mean?" or "Pick the
	 * best reply". The generator picks it to match what the challenge actually
	 * asks; absent means the UI falls back to its own default heading.
	 */
	instruction?: string;
	/** Exactly four options. */
	options: [string, string, string, string];
	/**
	 * Romanization of each option, index-aligned with `options`. Present only
	 * when the options are in the target script (i.e. `direction: 'toTarget'`).
	 */
	optionsRomanization?: string[];
	/** Index into `options`, 0-3. */
	correctIndex: number;
	/** `KnowledgeItem` ids exercised by this challenge. */
	itemIds: string[];
}

/** Fill the `___` blank in a sentence. */
export interface ClozeChallenge extends ChallengeBase {
	type: 'cloze';
	/** Sentence containing a `___` placeholder for the blank. */
	sentence: string;
	/**
	 * Romanization of the *whole* sentence, blank included — not just the
	 * answer. Present only when the sentence is in the target script.
	 */
	sentenceRomanization?: string;
	/** Any of these count as correct (before fuzzy matching). */
	acceptedAnswers: string[];
	/**
	 * Latin reading of the canonical accepted answer (`acceptedAnswers[0]`),
	 * copied by the resolver from that answer's own `reading`. The post-answer
	 * feedback shows it under "Answer: …", where the learner is being told a word
	 * they could not produce and most needs to know how to say. Absent for
	 * Latin-script targets, and absent from anything queued before the field
	 * existed — a missing reading simply renders no line.
	 */
	answerRomanization?: string;
	/** Optional set of draggable/tappable candidate words. */
	wordBank?: string[];
	/**
	 * Latin-script reading of each word bank entry, index-aligned with
	 * `wordBank`. Built by the resolver from the readings that ride along with
	 * the bank's words — never emitted by the model as a list of its own, so it
	 * cannot drift out of alignment. Present only when *every* bank word has a
	 * reading; a half-annotated bank would be worse than a bare one.
	 */
	wordBankRomanization?: string[];
	/** Native-language rendering of the full sentence. */
	translationHint: string;
	itemIds: string[];
}

/** Type the full translation of a prompt. */
export interface TypedTranslationChallenge extends ChallengeBase {
	type: 'typed-translation';
	prompt: string;
	/** Romanization of `prompt`, when the prompt is in the target script. */
	promptRomanization?: string;
	acceptedAnswers: string[];
	/**
	 * Latin reading of the canonical accepted answer (`acceptedAnswers[0]`), for
	 * the post-answer feedback. See {@link ClozeChallenge.answerRomanization};
	 * additionally absent when `direction` is `'toNative'`, where the answer is
	 * already in the learner's own language.
	 */
	answerRomanization?: string;
	itemIds: string[];
}

/** Match terms on the left with their counterparts on the right. */
export interface MatchPairsChallenge extends ChallengeBase {
	type: 'match-pairs';
	/**
	 * `a` is one side of the pair, `b` the other. `aRom`/`bRom` are the
	 * romanizations of the corresponding side, copied from the source item's
	 * `romanization` by the local generator — never model-produced.
	 */
	pairs: { a: string; b: string; aRom?: string; bRom?: string }[];
	itemIds: string[];
}

/** Any challenge; discriminate on `type`. */
export type Challenge =
	| MultipleChoiceChallenge
	| ClozeChallenge
	| TypedTranslationChallenge
	| MatchPairsChallenge;

/** Narrowing helper: the `type` tag of a `Challenge`. */
export type ChallengeType = Challenge['type'];

/** The learner's answer to a single challenge. */
export interface ChallengeResult {
	challengeId: string;
	verdict: Verdict;
	/** Raw input, kept for review screens and analytics. */
	answerGiven: string;
	/** Epoch milliseconds. */
	at: number;
}

/** Gamification counters. Days are `YYYY-MM-DD` in the learner's local time. */
export interface Stats {
	xp: number;
	streakDays: number;
	lastActiveDay: string;
	history: { day: string; xp: number }[];
}
