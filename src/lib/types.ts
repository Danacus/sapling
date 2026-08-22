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
	/** Optional usage notes, gender, conjugation hints, etc. */
	notes?: string;
	/** ts-fsrs `Card`. */
	fsrsCard: unknown;
	/** Epoch milliseconds. */
	introducedAt: number;
	/** Review log, newest last. `grade` is the ts-fsrs `Rating`. */
	history: { at: number; grade: number }[];
}

/** Fields shared by every challenge variant. */
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
	/** Exactly four options. */
	options: [string, string, string, string];
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
	/** Any of these count as correct (before fuzzy matching). */
	acceptedAnswers: string[];
	/** Optional set of draggable/tappable candidate words. */
	wordBank?: string[];
	/** Native-language rendering of the full sentence. */
	translationHint: string;
	itemIds: string[];
}

/** Type the full translation of a prompt. */
export interface TypedTranslationChallenge extends ChallengeBase {
	type: 'typed-translation';
	prompt: string;
	acceptedAnswers: string[];
	itemIds: string[];
}

/** Match terms on the left with their counterparts on the right. */
export interface MatchPairsChallenge extends ChallengeBase {
	type: 'match-pairs';
	/** `a` is one side of the pair, `b` the other. */
	pairs: { a: string; b: string }[];
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
