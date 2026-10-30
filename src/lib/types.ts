/**
 * Shared domain types for the whole app.
 *
 * Everything (db, srs, llm, challenges, ui) depends on this module. The types
 * are generated from the Rust structs (`crates/sapling-domain`,
 * `crates/sapling-srs`, `crates/sapling-import`, and the stored challenge
 * union in `crates/sapling-challenges`) into `$lib/db/generated/` at build
 * time and re-exported here, so a field changes by changing the struct. What
 * stays written here is TypeScript-only helpers over them. No runtime values:
 * types only.
 */

export type {
	Aim,
	Challenge,
	ChallengeAnswer,
	ChallengeScreen,
	ChallengeTypeInfo,
	ChallengeResult,
	Clip,
	ClozeChallenge,
	Conversation,
	ConversationAction,
	ConversationCorrection,
	ConversationExchange,
	ConversationLearnerTurn,
	ConversationLine,
	ConversationScenario,
	ConversationTeacherTurn,
	CueClozeChallenge,
	Direction,
	FsrsCardState,
	Feedback,
	Graded,
	GradeEntry,
	HistoryEntry,
	ImportedSource,
	ItemKind,
	ItemSrs,
	KnowledgeItem,
	Level,
	MatchPair,
	MatchPairsChallenge,
	MultiClozeChallenge,
	MultiClozeGap,
	MultipleChoiceChallenge,
	Profile,
	ReadingMedia,
	ReadingText,
	Segment,
	SpotErrorChallenge,
	Served,
	SubtitleFormat,
	TextSource,
	TypedTranslationChallenge,
	Verdict,
	WordOrderChallenge
} from './db/generated/index';
import type {
	Challenge,
	ChallengeAnswer,
	ChallengeScreen,
	ConversationLearnerTurn,
	ConversationTeacherTurn
} from './db/generated/index';

/** Narrowing helper: the `type` tag of a `Challenge`. */
export type ChallengeType = Challenge['type'];

/** The stored member, served screen and submitted answer belonging to one tag. */
export type ChallengeOf<T extends ChallengeType> = Extract<Challenge, { type: T }>;
export type ScreenOf<T extends ChallengeType> = Extract<ChallengeScreen, { type: T }>['screen'];
export type AnswerOf<T extends ChallengeType> = Extract<ChallengeAnswer, { type: T }>['answer'];

/** One row of a stored transcript. */
export type StoredConversationTurn = ConversationLearnerTurn | ConversationTeacherTurn;
