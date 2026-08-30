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
	/**
	 * Review log, newest last. `grade` is the ts-fsrs `Rating`.
	 *
	 * `device` is stamped by `$lib/device`'s stable per-browser id, and it is
	 * what makes a merged history dedupe exactly: an entry's identity is
	 * `(itemId, at, device)`, so two devices reviewing the same word in the
	 * same millisecond stay two reviews rather than collapsing into one.
	 * Entries without it predate the id and are attributed to a constant by
	 * the Dexie migration, so that both devices name them identically.
	 */
	history: { at: number; grade: number; device?: string }[];
	/**
	 * Folds of `history` the store maintains, so a bulk read never carries it.
	 *
	 * `getAllItems()` returns these with an empty `history`; `getItem()` returns
	 * both. Optional because anything that builds a `KnowledgeItem` by hand — a
	 * test, an import, the assistant — supplies `history` alone, so every read
	 * site falls back to it.
	 */
	reviewCount?: number;
	/** How many of the reviews were graded Good or better. */
	correctCount?: number;
	/**
	 * The most recent reviews, oldest first — what the ledger's tick strip shows.
	 *
	 * Absent unless the caller asked for it: `getAllItems({ withRecentGrades: true })`
	 * or `getItem()`. The plain `getAllItems()` bulk read leaves it out — it is up
	 * to `RECENT_GRADES_CAP` entries (~1 KB) per item and nothing else reads it.
	 */
	recentGrades?: { at: number; grade: number }[];
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

/**
 * Arrange shuffled target-language word tiles into the right sentence.
 *
 * The model does the segmentation (one tile per *word*, not per character),
 * which is what makes this type work for Chinese and Japanese at all. The
 * resolver does the shuffling, so tile order carries no signal.
 *
 * Grading compares the learner's sequence of tile **texts** to
 * {@link answerTokens}, never tile indices: a sentence that legitimately uses
 * the same word twice — or a distractor that happens to duplicate a real tile —
 * must not be able to fail a correct arrangement.
 */
export interface WordOrderChallenge extends ChallengeBase {
	type: 'word-order';
	/** The sentence to build, in the learner's native language. */
	prompt: string;
	/** Heading shown above the prompt; absent means the UI's default. */
	instruction?: string;
	/**
	 * Every tile the learner may place, already shuffled: the sentence's own
	 * words plus any distractors. Duplicates are legal — see the type note.
	 */
	tiles: string[];
	/**
	 * Latin reading of each tile, index-aligned with `tiles`. All-or-nothing,
	 * exactly like {@link ClozeChallenge.wordBankRomanization}: a half-annotated
	 * row of tiles reads worse than a bare one.
	 */
	tilesRomanization?: string[];
	/** The correct tile texts, in order. The answer key. */
	answerTokens: string[];
	/**
	 * `answerTokens` assembled into a sentence with the target script's own
	 * spacing rule (`joinTokens` in `$lib/text`) — what the feedback banner
	 * prints and what TTS speaks.
	 */
	answer: string;
	/** Latin reading of `answer`; absent for Latin-script targets. */
	answerRomanization?: string;
	itemIds: string[];
}

/**
 * Tap the one word in a target-language sentence that does not belong.
 *
 * `meaning` is load-bearing rather than decorative: without being told what the
 * sentence is *supposed* to say, a learner cannot tell a wrong word from a word
 * they simply do not know yet.
 */
export interface SpotErrorChallenge extends ChallengeBase {
	type: 'spot-error';
	/** The sentence as shown, one entry per word, with the wrong word in place. */
	tokens: string[];
	/** Latin reading of each token, index-aligned with `tokens`; all-or-nothing. */
	tokensRomanization?: string[];
	/** Index into `tokens` of the wrong word — tapping it is the correct answer. */
	correctIndex: number;
	/** The word that belongs at `correctIndex`; the banner's "should have been". */
	intendedWord: string;
	/** Latin reading of `intendedWord`; absent for Latin-script targets. */
	intendedWordRomanization?: string;
	/** The sentence with `intendedWord` restored — printed and spoken after answering. */
	correctedSentence: string;
	/** What the sentence is meant to say, in the learner's native language. */
	meaning: string;
	itemIds: string[];
}

/** Any challenge; discriminate on `type`. */
export type Challenge =
	| MultipleChoiceChallenge
	| ClozeChallenge
	| TypedTranslationChallenge
	| MatchPairsChallenge
	| WordOrderChallenge
	| SpotErrorChallenge;

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

/* -------------------------------------------------------------------------- */
/* Reading (comprehension) mode                                                */
/* -------------------------------------------------------------------------- */

/** One sentence of a {@link ReadingText}. */
export interface ReadingSentence {
	/** The sentence in the target language, verbatim. */
	text: string;
	/**
	 * Latin-script reading of `text`, for targets not written in the Latin
	 * script. The sentence-wide fallback for languages with no local romanizer
	 * (`$lib/romanize`); absent for Latin-script targets.
	 */
	reading?: string;
	/** The sentence in the learner's native language. */
	translation?: string;
}

/**
 * One glossed word: a word the text uses that is *not* in the learner's
 * vocabulary, with what it means. Never a knowledge item by itself — a word
 * enters the collection only when the learner adds it from the reader.
 *
 * For scripts written without spaces the glossary doubles as the segmentation
 * dictionary: the tokenizer groups characters around these terms, so a glossed
 * word renders as one cell rather than one per character.
 */
export interface GlossEntry {
	/** As it appears in the text (base form is fine for inflecting languages). */
	term: string;
	/** Latin reading of `term`; absent for Latin-script targets. */
	reading?: string;
	/** Meaning in the learner's native language. */
	meaning: string;
}

/**
 * A text the learner reads (or listens to) for comprehension — written by the
 * model from their vocabulary, or pasted in from elsewhere and annotated.
 *
 * Immutable once stored, like a challenge: the annotations are what the model
 * produced at creation time, and everything adaptive (which readings show, which
 * words are highlighted) is derived at render time from the vocabulary and the
 * learner's marks — so old texts pick up new knowledge for free.
 */
export interface ReadingText {
	id: string;
	/** Short, in the target language. */
	title: string;
	/** `'generated'` by the model from the vocabulary, or `'imported'` by the learner. */
	source: 'generated' | 'imported';
	/** The learner's topic, when a generated text was asked for one. */
	topic?: string;
	sentences: ReadingSentence[];
	glossary: GlossEntry[];
	/** Epoch milliseconds. */
	createdAt: number;
}

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The stored side of conversation mode, mirroring `$lib/conversation`'s
 * `Scenario`, `TargetLine`, `Correction`, `LearnerTurn` and `TeacherTurn`
 * **structurally** rather than importing them.
 *
 * This module is deliberately dependency-free (see the file header) and
 * `$lib/conversation` imports it for `Profile`, so importing back would close a
 * cycle. Structural identity is what keeps the duplication harmless: TypeScript
 * assigns these to the conversation module's types and back with no conversion
 * anywhere, so the page hands `sendTurn`'s output straight to `addExchange` and
 * a stored transcript straight to the turn renderer. The two definitions have to
 * stay in step; a drift fails `pnpm check` at the page, which is where both
 * sides meet.
 */

/** One line of the target language with its Latin reading. Mirrors `TargetLine`. */
export interface ConversationLine {
	text: string;
	/** Absent for targets already written in the Latin script. */
	reading?: string;
}

/** The scene both sides play, fixed for a conversation's whole life. */
export interface ConversationScenario {
	/** Native language: the setup has to be understood before the target language starts. */
	setting: string;
	teacherRole: string;
	learnerRole: string;
	firstSpeaker: 'teacher' | 'learner';
	/** The teacher's opening line — present exactly when it speaks first. */
	opener?: ConversationLine;
	openerTranslation?: string;
}

/** The learner's whole message rewritten, with an optional note. Mirrors `Correction`. */
export interface ConversationCorrection {
	corrected: ConversationLine;
	note?: string;
}

/** One tool the teacher ran on a turn — `add_words`, in practice. Mirrors `ActionNote`. */
export interface ConversationAction {
	tool: string;
	summary: string;
	ok: boolean;
}

/**
 * What the learner wrote, with what came back *about* it.
 *
 * `heard` and `correction` arrive with the *next* teacher turn and belong to
 * this bubble, so they are stored on it — which is also the pairing the turn
 * model is shown when the dialogue is replayed.
 */
export interface ConversationLearnerTurn {
	role: 'learner';
	/** Exactly what they typed, never the corrected version. */
	text: string;
	heard?: ConversationLine;
	correction?: ConversationCorrection;
}

/** One teacher line, with whatever it filed away while writing it. */
export interface ConversationTeacherTurn {
	role: 'teacher';
	reply: ConversationLine;
	translation?: string;
	actions: ConversationAction[];
}

/** One row of a stored transcript. */
export type StoredConversationTurn = ConversationLearnerTurn | ConversationTeacherTurn;

/**
 * A role-played conversation, as the library lists it.
 *
 * The scene is immutable — it is decided once, before the first line — so the
 * only thing that ever grows is the transcript, one {@link ConversationExchange}
 * at a time.
 */
export interface Conversation {
	id: string;
	scenario: ConversationScenario;
	/** What the learner asked to talk about, when they asked for anything. */
	topic?: string;
	/** Epoch milliseconds. */
	createdAt: number;
}

/**
 * The unit of persistence: one learner message and the teacher turn that
 * answered it.
 *
 * The pair is stored together because that is the only state the turn loop can
 * resume from — a learner message whose reply never came back is not history,
 * it is a failed send. `learner` is absent only at index 0, where the scenario's
 * opener seeds the transcript with a teacher line nobody prompted.
 *
 * Identity is `(conversationId, index)`, which is derived from the content and
 * so is the same on every device.
 */
export interface ConversationExchange {
	conversationId: string;
	/** Position in the transcript, from 0. */
	index: number;
	learner?: ConversationLearnerTurn;
	teacher: ConversationTeacherTurn;
}
