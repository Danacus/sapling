/**
 * Batch generation: turn the learner's profile plus their due/new items into a
 * playable set of challenges.
 *
 * This is the token-economy heart of the app. One batched call produces a whole
 * lesson; grading happens locally for free (`$lib/validate`, `$lib/srs`) and
 * only an explicit "explain this" escalates to a second call
 * (`./escalation`). `match-pairs` never costs a token at all — see
 * {@link makeMatchPairsChallenge}.
 *
 * Everything here is stateless with respect to the database: data in, data out.
 * The caller persists the result.
 */

import { getModel } from '$lib/db/settings';
import { isPunctuationOnly, joinTokens, mergePunctuationTokens } from '$lib/text';
import type { Challenge, ClozeChallenge, KnowledgeItem, Profile } from '$lib/types';
import { foldDiacritics } from '$lib/validate';
import { chatCompletion, LlmError } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';
import {
	BATCH_SCHEMA_NAME,
	NEW_ITEM_REF,
	batchJsonSchema,
	generatedChallengeSchema,
	generatedItemSchema,
	looseBatchSchema
} from './schemas';
import type { GeneratedChallenge, GeneratedCloze, GeneratedItem, TargetText } from './schemas';

/** Hard ceiling on challenges per batch, so one call can never run away. */
export const MAX_BATCH_CHALLENGES = 20;

/** Below this many salvaged challenges a batch is not worth playing. */
export const MIN_BATCH_CHALLENGES = 5;

export interface ReviewItemRef {
	id: string;
	term: string;
	meaning: string;
}

export interface RecentMistake {
	term: string;
	/** What the learner answered; `'(skipped)'` when they gave up on it. */
	gave: string;
}

/* -------------------------------------------------------------------------- */
/* Progress reporting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The coarse phases a refill goes through, in the order they normally fire.
 *
 * They exist for one reason: generation takes seconds and the learner deserves
 * to see *which* second is being spent where — above all whether it is the API
 * call. `queue-check`, `select-items` and `save` are emitted by the session
 * engine, the rest by {@link generateBatch} (and by the mock, so practice mode
 * walks the same list, just instantly).
 */
export type ProgressStepId =
	| 'queue-check'
	| 'select-items'
	| 'build-prompt'
	| 'request'
	| 'validate'
	| 'retry'
	| 'save';

/**
 * One step *starting*. Duration is the caller's business: it times each step
 * from this event to the next one (and the last one to the promise resolving).
 */
export interface ProgressStep {
	id: ProgressStepId;
	/** Human-readable, already written for display. */
	label: string;
}

/** Callback threaded through the refill so the UI can show a live step log. */
export type OnProgress = (step: ProgressStep) => void;

/**
 * Hard ceiling on the learner's self-description, in characters.
 *
 * The learner types this text and nobody reviews it, so the prompt budget must
 * not depend on their restraint: an essay pasted into the box would ride along
 * with *every* batch call for as long as it stays there. Enforced here by a
 * deterministic trim-then-slice rather than by asking the model to ignore the
 * tail, and mirrored as a `maxlength` on the profile page so the cut is visible
 * while typing instead of silent at generation time.
 */
export const MAX_ABOUT_CHARS = 500;

export type BatchProfile = Pick<
	Profile,
	'nativeLanguage' | 'targetLanguage' | 'level' | 'interests' | 'about'
>;

export interface BatchArgs {
	profile: BatchProfile;
	/** Items the SRS says are due; challenges should exercise these. */
	reviewItems: ReviewItemRef[];
	/** How many brand-new items the batch may introduce. */
	newItemSlots: number;
	recentMistakes?: RecentMistake[];
	/**
	 * Share of recent reviews the learner got right, 0..1 — the difficulty dial
	 * for the batch (see the calibration rules in the system prompt). Absent on
	 * day one, when there is no history to judge by.
	 */
	recentAccuracy?: number;
	/** Overrides the derived challenge count. */
	count?: number;
	/**
	 * Free-form scenario for this session, e.g. `'ordering in a restaurant'` or
	 * `'talking about your hobbies'`. When set, every challenge in the batch is
	 * a line of dialogue from that situation; the learner's `interests` then only
	 * colour word choice. Blank/absent means "no scenario", and costs no tokens.
	 */
	topic?: string;
	/**
	 * Every item the learner already has, review-due or not. Three jobs:
	 * `newItems` must not repeat any of their terms (the model only sees due
	 * items otherwise, so it re-proposes common words and the dedupe silently
	 * eats the batch's new-word slots); sentences should prefer drawing on them,
	 * so new material is mostly readable instead of full of untracked strangers;
	 * and a challenge built on one of them may cite it in `itemIds` **by its
	 * term** — the resolver maps terms back to ids locally.
	 *
	 * Only the terms travel in the prompt (a few hundred words costs well under
	 * 1k tokens, paid only on explicit generation). The ids stay on this side:
	 * the model never sees them, so it cannot be asked to echo them back — that
	 * is exactly why term citations must be legal. See {@link knownTermIndex}.
	 */
	knownItems?: KnownItemRef[];
}

/** One already-known word: the id the app uses, the term the model sees. */
export interface KnownItemRef {
	id: string;
	term: string;
}

export interface BatchOptions {
	fetchFn?: FetchLike;
	model?: string;
	apiKey?: string;
	signal?: AbortSignal;
	/** Injectable id factory; defaults to `crypto.randomUUID()`. */
	newId?: () => string;
	/** Injectable clock in epoch ms; defaults to `Date.now()`. */
	now?: () => number;
	/** Called as each generation step starts; see {@link ProgressStep}. */
	onProgress?: OnProgress;
	/**
	 * Injectable `[0,1)` source for the option/word-bank shuffles the resolver
	 * performs; defaults to `Math.random`. Only tests and the mock pass one.
	 */
	rng?: () => number;
}

export interface BatchResult {
	challenges: Challenge[];
	/**
	 * Freshly introduced vocabulary. `fsrsCard` is `null`: this layer does not
	 * depend on ts-fsrs. **The caller must initialize card state** (see
	 * `$lib/srs`) before persisting these.
	 */
	newItems: KnowledgeItem[];
	usage: TokenUsage;
}

// --------------------------------------------------------------------------
// Prompt
// --------------------------------------------------------------------------

/**
 * The system prompt. Written for tokens, not for looks: no pleasantries, one
 * inline example per challenge type, rules as bare imperatives. Roughly 1450
 * prompt tokens — seven types cost more to spell out than five, and the whole
 * per-field romanization block they replace is gone — unchanged across every
 * call, so it caches well on providers that support prompt caching. It buys
 * back more than it costs: better challenges mean fewer regenerated batches,
 * and the content-only wire format keeps grading local.
 *
 * Three blocks earn their keep beyond the bare schema:
 *
 * - **Answerability.** Left to itself the model writes scene-dependent prompts
 *   ("where is the fish stall?") whose expected answer comes from a scene the
 *   learner was never shown. The rule forces every prompt to determine its own
 *   answer, or to spell the line out.
 *
 * - **Voice.** Left to itself the model writes flashcard prose — "I like to
 *   cook", "Cooking is fun" — one bland declarative per interest. The voice
 *   rules force dialogue turns, questions and situational phrases instead, and
 *   name the bland patterns explicitly so they can be refused.
 * - **Romanization.** Non-Latin scripts are unreadable and untypeable for a
 *   beginner, so every target-language string travels as a `TargetText`: the
 *   text and its Latin reading together, in one object. That is the whole rule —
 *   there is no per-field table of which reading applies where, no reading can
 *   be misaligned with the string it annotates, and a reading cannot leak the
 *   answer to a challenge it is not part of. The app derives the toneless
 *   spellings from the readings it is given, so the model never spends tokens
 *   listing "nǐ hǎo" and "ni hao" side by side. Latin-script targets send
 *   `"reading": null` everywhere and pay nothing.
 */
const SYSTEM_PROMPT = [
	'You are an expert language-course author. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"challenges":[Challenge],"newItems":[{"term","meaning","romanization","notes"}]}',
	'Every Challenge has: type, itemIds, explanation (one short sentence or null). The rest of its fields depend on the type.',
	'TargetText, written {"text":..,"reading":..}, is one string of the TARGET language plus its Latin reading: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. "reading" is ALWAYS null when the target language is written in the Latin script. Every field that is not a TargetText is plain text in the NATIVE language.',
	'Types:',
	'recognize-mc — target text shown, native meaning picked. {shown:TargetText, correctMeaning, distractors:[3], instruction} e.g. {"type":"recognize-mc","shown":{"text":"el perro","reading":null},"correctMeaning":"the dog","distractors":["the cat","the bread","the house"],"instruction":null,"itemIds":["i1"],"explanation":null}',
	'produce-mc — native prompt shown, target text picked. {promptNative, correct:TargetText, distractors:[3 TargetText], instruction} e.g. {"type":"produce-mc","promptNative":"to order (food in a restaurant)","correct":{"text":"pedir","reading":null},"distractors":[{"text":"pagar","reading":null},{"text":"probar","reading":null},{"text":"servir","reading":null}],"instruction":null,"itemIds":["i2"],"explanation":null}',
	'cloze — one target-language word missing from a target-language sentence. {before:TargetText, answer:TargetText, after:TargetText, hintNative, distractorWords:[3-5 TargetText] or null} e.g. {"type":"cloze","before":{"text":"你好，请给我一份","reading":"Nǐ hǎo, qǐng gěi wǒ yī fèn"},"answer":{"text":"菜单","reading":"càidān"},"after":{"text":"。","reading":"."},"hintNative":"Hello, could I have a menu, please?","distractorWords":[{"text":"筷子","reading":"kuàizi"},{"text":"茶","reading":"chá"},{"text":"水","reading":"shuǐ"}],"itemIds":["i3"],"explanation":"份 (fèn) is the measure word for a menu or a portion."} — before and after carry their own spacing and punctuation and the app puts the blank between them; either may be {"text":"","reading":null}. hintNative is the whole sentence in the native language. distractorWords null means the learner types the answer.',
	'translate-to-target — type the target language. {promptNative, answers:[TargetText, 1 or more]} e.g. {"type":"translate-to-target","promptNative":"Excuse me, the bill please.","answers":[{"text":"服务员，买单","reading":"fúwùyuán, mǎidān"},{"text":"买单","reading":"mǎidān"}],"itemIds":["i4"],"explanation":null}',
	'translate-to-native — type the native language. {prompt:TargetText, answersNative:[1 or more]} e.g. {"type":"translate-to-native","prompt":{"text":"la cuenta","reading":null},"answersNative":["the bill","the check"],"itemIds":["i5"],"explanation":null}',
	'word-order — build a target sentence out of tiles. {promptNative, words:[2+ TargetText — the sentence split into tiles, IN THE CORRECT ORDER], distractorWords:[0-3 TargetText] or null, instruction} e.g. {"type":"word-order","promptNative":"Could you bring us the bill, please?","words":[{"text":"¿Nos","reading":null},{"text":"trae","reading":null},{"text":"la","reading":null},{"text":"cuenta,","reading":null},{"text":"por","reading":null},{"text":"favor?","reading":null}],"distractorWords":[{"text":"carta","reading":null}],"instruction":null,"itemIds":["i6"],"explanation":null} — the app shuffles the tiles, so never state an order anywhere else.',
	'spot-error — one wrong word in a target sentence. {words:[3+ TargetText — the CORRECT sentence split into tiles, in order], wrongWord:TargetText, wrongPosition:int, meaningNative} e.g. {"type":"spot-error","words":[{"text":"我们","reading":"wǒmen"},{"text":"想","reading":"xiǎng"},{"text":"买单","reading":"mǎidān"}],"wrongWord":{"text":"菜单","reading":"càidān"},"wrongPosition":2,"meaningNative":"We would like to pay the bill.","itemIds":["i7"],"explanation":null} — the app replaces words[wrongPosition] with wrongWord and asks the learner to tap it.',
	'Rules:',
	'- itemIds: the id of a reviewItem, "new:<index>" for an entry of newItems (0-based), or — for a challenge built on a word from known — that word exactly as it appears in known. Never invent anything else.',
	'- Produce exactly one challenge object per requested slot; give the same review item different types.',
	'- Mix recognition and production across the batch.',
	'- Distractors must be plausible: same part of speech and register, never synonyms of the correct answer, never obviously absurd. Exactly one of the four may be correct given the prompt; if two would both answer it, rewrite the prompt.',
	'- translate-to-target answers must be exhaustive, one entry per genuinely different way to say it: with and without the article, contractions, common synonyms and word orders. Do NOT list tone- or accent-stripped spellings — the app derives those from "reading".',
	'- Answerable from what is shown alone: the prompt, plus the challenge type, must uniquely determine the answer. Never an open question whose answer depends on facts you never state — directions, prices, names, times, opinions, anything from an imagined scene the learner cannot see.',
	'- In a situational dialogue either give the exact line to produce ("Say: \'the fish stall is to the right\'") or make answers cover every plausible alternative reply.',
	'- instruction: a short heading, in the NATIVE language, matched to what the challenge actually asks — "What does this mean?" for a plain meaning question, "Pick the best reply" or "How would you answer?" for a conversational turn; null when the default meaning-question heading fits.',
	'- Cloze sentences use only vocabulary at or below the learner level.',
	'- Segmentation (word-order, spot-error): one tile per WORD, never per character or syllable, and punctuation rides on the tile it touches — never a tile of its own ("吗？" is one tile, "？" alone is not a tile). For Chinese and Japanese split on word boundaries — 菜单 is one tile, not 菜 + 单. Each tile is a TargetText and carries its own reading under the usual rule.',
	'- word-order sentences must have exactly one natural order: if the same tiles could be rearranged into a second correct sentence, rewrite it. Keep them to 4-8 tiles — 8 is a hard limit; past it, shorten the sentence. distractorWords are plausible words that fit nowhere in the sentence, never a form of a word already in it.',
	'- spot-error: wrongWord must be a real target-language word that is unambiguously wrong in that slot given meaningNative — same part of speech, wrong meaning — never a synonym, a spelling slip or a stylistic quibble. wrongPosition is a 0-based index into words, and wrongWord must differ from the word it replaces.',
	'- newItems must fit the learner level; term in the target language, meaning in the native language, romanization as in TargetText (null for Latin scripts), notes only for gender/irregularity/register.',
	'- Exactly newItemSlots entries in newItems, and every one of them must be used by at least one challenge.',
	'- known lists vocabulary the learner already has. newItems must NOT repeat anything in it (no exact repeats, no trivial variants of a known term) — introduce genuinely new words. Prefer building sentences out of known words plus this batch\'s newItems, so the learner mostly reads what they can already read.',
	'Difficulty calibration:',
	'- recentAccuracy (0-1, share of recent answers the learner got right) and recentMistakes are their current form; calibrate the batch to them.',
	'- recentAccuracy below 0.7: favour recognition — recognize-mc, produce-mc and cloze WITH distractorWords — keep answers to one or two words, and avoid full-sentence translate-to-target.',
	'- recentAccuracy above 0.85: lean into production — translate-to-target and cloze without distractorWords, longer sentences.',
	'- Every term in recentMistakes gets one more challenge in this batch, EASIER than last time and in a different format from the one it was failed in.',
	'- gave "(skipped)" means the format was too demanding for that term: re-practise it with a recognition format.',
	'Voice:',
	'- Conversation, not flashcards: every prompt, sentence and translation is a line someone would really say — a dialogue turn, a question put to the learner, a request, a reaction, an opinion. Never an isolated textbook statement.',
	'- With a "topic", EVERY challenge happens inside that scenario: cloze sentences are turns of that dialogue, translations are things you would really say there, newItems are words the scenario needs. "interests" then only colour word choice, never the sentence frame.',
	'- "about" is the learner in their own words. Set scenarios in their life — their city, work, people, tastes — and let it colour word choice and examples. Never recite it back to them, never contradict it, and "topic" still outranks it.',
	'- Banned: "I like <interest>", "<interest> is fun", any sentence whose only content is that the learner likes their interest, and reusing a sentence frame twice in one batch. Vary speaker, question vs statement, and register for the level.',
	'- explanation: one line of usage or culture (register, politeness, word order) when non-obvious, written in the NATIVE language (target-language words may be quoted inside it); null when it would only restate the answer.'
].join('\n');

/** Default batch size: two challenges per review item, two per new item. */
export function defaultChallengeCount(reviewItems: number, newItemSlots: number): number {
	return Math.min(MAX_BATCH_CHALLENGES, Math.max(1, reviewItems * 2 + newItemSlots * 2));
}

/**
 * Builds the two messages for one batch call. The user message is compact JSON
 * — no field labels in prose, no restating of the rules.
 */
export function buildBatchPrompt(args: BatchArgs): ChatMessage[] {
	const { profile, reviewItems, newItemSlots } = args;
	const count = args.count ?? defaultChallengeCount(reviewItems.length, newItemSlots);

	const topic = args.topic?.trim();
	const about = profile.about?.trim().slice(0, MAX_ABOUT_CHARS);

	const payload: Record<string, unknown> = {
		native: profile.nativeLanguage,
		target: profile.targetLanguage,
		level: profile.level,
		// Placed before `interests` on purpose: the scenario outranks the
		// interests, and models weight earlier keys more heavily.
		...(topic ? { topic } : {}),
		interests: profile.interests,
		// Right after `interests` — it is the same kind of signal, only richer —
		// and still below `topic`, which outranks both. Capped: see
		// {@link MAX_ABOUT_CHARS}.
		...(about ? { about } : {}),
		challengeCount: Math.min(count, MAX_BATCH_CHALLENGES),
		newItemSlots,
		reviewItems: reviewItems.map((i) => ({ id: i.id, t: i.term, m: i.meaning })),
		// Terms only — the ids stay local (see `knownItems` and `knownTermIndex`).
		...(args.knownItems?.length ? { known: args.knownItems.map((i) => i.term) } : {})
	};
	if (args.recentAccuracy !== undefined && Number.isFinite(args.recentAccuracy)) {
		payload.recentAccuracy = Math.round(args.recentAccuracy * 100) / 100;
	}
	if (args.recentMistakes?.length) {
		payload.recentMistakes = args.recentMistakes.map((m) => ({ t: m.term, gave: m.gave }));
	}

	return [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/** Appended verbatim when a first attempt came back mostly unusable. */
export const CORRECTIVE_INSTRUCTION =
	'Your previous reply was rejected. Return ONLY a raw JSON object {"challenges":[...],"newItems":[...]}, no fences, no commentary. Every challenge needs type, itemIds and its own fields: recognize-mc {shown,correctMeaning,distractors}, produce-mc {promptNative,correct,distractors}, cloze {before,answer,after,hintNative}, translate-to-target {promptNative,answers}, translate-to-native {prompt,answersNative}, word-order {promptNative,words}, spot-error {words,wrongWord,wrongPosition,meaningNative}. Every target-language slot is a TargetText object {"text","reading"}, reading null for Latin scripts; distractors is exactly 3 entries.';

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

/**
 * Removes markdown fences and any chatter around the JSON object. Models drop
 * back into ```json blocks constantly, schema or not.
 */
export function stripFences(text: string): string {
	let out = text.trim();
	const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/;
	const match = fence.exec(out);
	if (match) out = match[1].trim();
	if (out.startsWith('{')) return out;
	// Fall back to the outermost brace pair.
	const start = out.indexOf('{');
	const end = out.lastIndexOf('}');
	if (start >= 0 && end > start) return out.slice(start, end + 1).trim();
	return out;
}

export interface ParsedBatch {
	challenges: GeneratedChallenge[];
	newItems: GeneratedItem[];
	/** Entries thrown away because they failed validation. */
	dropped: number;
}

/**
 * Parses a completion into validated entries, salvaging what it can: a single
 * malformed challenge costs us that challenge, not the batch we already paid
 * for. Throws `LlmError('bad-response')` only when the envelope itself is
 * unusable.
 */
export function parseBatch(raw: string): ParsedBatch {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not return JSON. Try again.', { cause });
	}

	const envelope = looseBatchSchema.safeParse(json);
	if (!envelope.success) {
		throw new LlmError(
			'bad-response',
			'The model returned JSON in an unexpected shape. Try again.'
		);
	}

	let dropped = 0;
	const challenges: GeneratedChallenge[] = [];
	for (const entry of envelope.data.challenges ?? []) {
		const parsed = generatedChallengeSchema.safeParse(entry);
		if (parsed.success) challenges.push(parsed.data);
		else dropped++;
	}

	const newItems: GeneratedItem[] = [];
	for (const entry of envelope.data.newItems ?? []) {
		const parsed = generatedItemSchema.safeParse(entry);
		if (parsed.success) newItems.push(parsed.data);
		else dropped++;
	}

	return { challenges, newItems, dropped };
}

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

function makeId(newId?: () => string): string {
	if (newId) return newId();
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function undefinedIfBlank(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * `{ key: trimmed }` when the value is a non-blank string, `{}` otherwise — so
 * an optional field is *absent* rather than present-and-undefined. Models emit
 * `null` for "not applicable" far more often than they omit the key, and a
 * Latin-script lesson should carry no romanization keys at all.
 */
function optionalString<K extends string>(
	key: K,
	value: string | null | undefined
): Partial<Record<K, string>> {
	const trimmed = undefinedIfBlank(value);
	return trimmed ? ({ [key]: trimmed } as Record<K, string>) : {};
}

/** The blank a cloze sentence is built around. */
const CLOZE_GAP = '___';

/** Case- and whitespace-insensitive key used to detect colliding labels. */
function labelKey(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Key for matching a model-cited term against the known list; forgiving on case and stray spaces. */
function termKey(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * The term → id index {@link resolveBatch} uses to honour term citations in
 * `itemIds`. Built from everything the model saw a term for: the known list
 * (which travels without ids on purpose) and the review items (whose ids the
 * model *was* given, but which it sometimes cites by term anyway — the intent
 * is unambiguous, so honouring it beats dropping a paid-for challenge).
 */
export function knownTermIndex(args: BatchArgs): Map<string, string> {
	const index = new Map<string, string>();
	for (const item of args.reviewItems) index.set(termKey(item.term), item.id);
	for (const item of args.knownItems ?? []) index.set(termKey(item.term), item.id);
	return index;
}

/** Fisher-Yates over a copy; `rng` is injectable so shuffles can be replayed. */
function shuffled<T>(values: readonly T[], rng: () => number): T[] {
	const out = [...values];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** The trimmed Latin reading of a target-language slot, or `undefined`. */
function readingOf(value: { reading?: string | null }): string | undefined {
	return undefinedIfBlank(value.reading);
}

/**
 * Trims, drops blanks and removes exact repeats, preserving order. Entry 0 stays
 * the canonical form: the UI speaks and displays it as *the* answer.
 */
function dedupe(values: (string | null | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Every spelling of one target-language answer the free local validator should
 * accept: the text, its reading, and both with diacritics folded away — so
 * "ni hao" and "el agua esta fria" grade correct without the validator needing
 * script-aware logic of its own. Derived here rather than asked for, which is
 * why the prompt forbids spending tokens on accent variants.
 */
function answerVariants(target: TargetText): string[] {
	const text = target.text.trim();
	const reading = readingOf(target);
	return dedupe([
		text,
		reading,
		reading ? foldDiacritics(reading) : undefined,
		foldDiacritics(text)
	]);
}

/** One choosable answer, with the reading that belongs to it. */
interface Choice {
	text: string;
	reading?: string;
	correct?: boolean;
}

/**
 * Lays four choices out in a random order and reports where the right one
 * landed.
 *
 * Position is decided here and never by the model: asked for a `correctIndex`,
 * models answer 0 far more often than chance, and a learner who notices trains
 * "always pick the first one" instead of the language.
 *
 * `optionsRomanization` is all-or-nothing — a column with one gap in it reads
 * worse than no column at all — and is built from the readings that travelled
 * with the options through the same shuffle, so it cannot fall out of step.
 */
function assembleChoices(choices: Choice[], rng: () => number) {
	const order = shuffled(choices, rng);
	const [a, b, c, d] = order.map((choice) => choice.text);
	const readings = order.map((choice) => choice.reading);
	const correctAt = order.findIndex((choice) => choice.correct);
	return {
		options: [a, b, c, d] as [string, string, string, string],
		correctIndex: correctAt < 0 ? 0 : correctAt,
		...(readings.every((r): r is string => !!r) ? { optionsRomanization: readings } : {})
	};
}

/** Latin readings are space-separated, so the blank needs air around it. */
const OPENS_WITH_WORD = /^[\p{L}\p{N}]/u;

/**
 * The reading of a cloze sentence, blank included.
 *
 * Built from `before` and `after` only. The answer's reading lives in a field
 * of its own and is never concatenated in, so the line a learner sees before
 * answering structurally cannot spell out the word they are being asked for —
 * there is no guard here to forget. The reading is dropped whenever a visible
 * part lacks one, since a half-romanized sentence is worse than none.
 */
function clozeSentenceRomanization(
	generated: GeneratedCloze
): Partial<Record<'sentenceRomanization', string>> {
	// No reading on the answer means a Latin-script target: no readings anywhere.
	if (!readingOf(generated.answer)) return {};
	for (const part of [generated.before, generated.after]) {
		if (part.text.trim() && !readingOf(part)) return {};
	}
	const head = readingOf(generated.before) ?? '';
	const tail = readingOf(generated.after) ?? '';
	if (!head && !tail) return {};
	const gapTail = OPENS_WITH_WORD.test(tail) ? ' ' : '';
	const line = `${head}${head ? ' ' : ''}${CLOZE_GAP}${gapTail}${tail}`
		.replace(/\s+/g, ' ')
		.trim();
	return { sentenceRomanization: line };
}

/**
 * The tappable candidate words for a cloze, shuffled with the answer among
 * them.
 *
 * Distractors that collide with the answer (or with each other) are dropped:
 * two identical chips make one of them wrong by position alone. The answer
 * itself never is. A bank of fewer than two chips is not a choice, so the
 * challenge falls back to typing.
 */
function clozeWordBank(
	answer: TargetText,
	distractors: TargetText[] | null | undefined,
	rng: () => number
): Partial<Pick<ClozeChallenge, 'wordBank' | 'wordBankRomanization'>> {
	if (!distractors?.length) return {};
	const answerChoice: Choice = { text: answer.text.trim(), reading: readingOf(answer) };
	const seen = new Set([labelKey(answerChoice.text)]);
	const entries = shuffled(
		[answerChoice, ...distractors.map((d) => ({ text: d.text.trim(), reading: readingOf(d) }))],
		rng
	).filter((entry) => {
		if (entry === answerChoice) return true;
		const key = labelKey(entry.text);
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (entries.length < 2) return {};

	const readings = entries.map((entry) => entry.reading);
	return {
		wordBank: entries.map((entry) => entry.text),
		...(readings.every((r): r is string => !!r) ? { wordBankRomanization: readings } : {})
	};
}

/**
 * Ceiling on the extra wrong tiles a `word-order` challenge may carry.
 *
 * A tray with twice as many tiles as the sentence needs stops being a word-order
 * exercise and becomes a search. An oversized list is cosmetic, so the resolver
 * trims it rather than dropping a challenge we already paid for.
 */
export const MAX_WORD_ORDER_DISTRACTORS = 3;

/**
 * Ceiling on the whole tray (sentence tiles + distractors). The prompt asks for
 * 4-8 sentence tiles but models overshoot; when they do, the distractor
 * allowance shrinks first — the sentence itself is the content we paid for and
 * cannot be trimmed, but nothing obliges us to pad an oversized one further.
 */
export const MAX_WORD_ORDER_TILES = 10;

/** One segmented word: its text and the reading that travels with it. */
interface Token {
	text: string;
	reading?: string;
}

/** Trims a `TargetText` list into tokens; `undefined` when any of them is blank. */
function tokenize(words: TargetText[]): Token[] | undefined {
	const tokens = words.map((word) => ({ text: word.text.trim(), reading: readingOf(word) }));
	return tokens.every((token) => token.text) ? tokens : undefined;
}

/**
 * `{ key: readings }` when *every* token has one, `{}` otherwise.
 *
 * All-or-nothing for the same reason as `optionsRomanization`: a row of tiles
 * where three are annotated and one is not reads worse than a bare row, and the
 * gap looks like a bug rather than a missing reading.
 */
function tokenReadings<K extends string>(key: K, tokens: Token[]): Partial<Record<K, string[]>> {
	const readings = tokens.map((token) => token.reading);
	return readings.every((reading): reading is string => !!reading)
		? ({ [key]: readings } as Record<K, string[]>)
		: {};
}

export interface ResolveOptions {
	newId?: () => string;
	now?: () => number;
	/** Ids the model was allowed to reference. Omit to accept any non-`new:` id. */
	knownItemIds?: Iterable<string>;
	/**
	 * Term → item id, for references the model makes *by term*. Known words
	 * travel to the model as bare terms (their ids never leave this side to keep
	 * the prompt cheap), so a challenge built on one can only cite the term —
	 * see {@link knownTermIndex}, which builds this from the batch args.
	 */
	termToId?: ReadonlyMap<string, string>;
	/** Injectable `[0,1)` source for the shuffles; defaults to `Math.random`. */
	rng?: () => number;
}

export interface ResolvedBatch {
	challenges: Challenge[];
	newItems: KnowledgeItem[];
	/** Challenges discarded because none of their itemIds resolved. */
	dropped: number;
}

/**
 * Turns validated model output into domain objects: mints challenge ids,
 * materializes `newItems` as `KnowledgeItem`s, rewrites every `new:<index>`
 * reference to the real id — and assembles the presentation the model was never
 * asked for.
 *
 * That assembly is where the wire format pays off. The model supplies content;
 * this function decides direction, option order, the position of the blank and
 * which readings are safe to show, so the failure modes that presentation
 * invites (a correct answer always in slot A, a romanization that spells out the
 * word behind the blank, a reading under the wrong option) cannot be expressed
 * in the first place.
 *
 * Salvage philosophy is unchanged: a cosmetic defect — a missing or partial
 * reading, a word bank that dedupes down to nothing — degrades silently, and
 * only a structural failure (no resolvable `itemIds`) costs a challenge.
 *
 * The returned `KnowledgeItem.fsrsCard` is `null` — a deliberate placeholder.
 * The caller owns card initialization (`$lib/srs`); this layer stays free of
 * ts-fsrs.
 *
 * Mock generation runs through this exact function, so the mock exercises the
 * real code path.
 */
export function resolveBatch(batch: ParsedBatch, options: ResolveOptions = {}): ResolvedBatch {
	const now = options.now?.() ?? Date.now();
	const known = options.knownItemIds ? new Set(options.knownItemIds) : undefined;
	const rng = options.rng ?? Math.random;

	const newItems: KnowledgeItem[] = batch.newItems.map((item) => ({
		id: makeId(options.newId),
		kind: 'vocab',
		term: item.term.trim(),
		meaning: item.meaning.trim(),
		...optionalString('romanization', item.romanization),
		...(undefinedIfBlank(item.notes) ? { notes: undefinedIfBlank(item.notes) } : {}),
		// Placeholder: the caller initializes real FSRS card state.
		fsrsCard: null,
		introducedAt: now,
		history: []
	}));

	const usedNewIndexes = new Set<number>();
	const challenges: Challenge[] = [];
	let dropped = 0;

	for (const generated of batch.challenges) {
		const itemIds: string[] = [];
		for (const ref of generated.itemIds) {
			const placeholder = NEW_ITEM_REF.exec(ref);
			if (placeholder) {
				const index = Number.parseInt(placeholder[1], 10);
				const item = newItems[index];
				if (!item) continue; // Dangling placeholder.
				usedNewIndexes.add(index);
				itemIds.push(item.id);
				continue;
			}
			// A term citation: known words reach the model without ids, so "this
			// challenge is about 护照" can only be said with the word itself.
			const byTerm = options.termToId?.get(termKey(ref));
			if (byTerm) {
				itemIds.push(byTerm);
				continue;
			}
			if (known && !known.has(ref)) continue; // Hallucinated id.
			itemIds.push(ref);
		}

		const unique = [...new Set(itemIds)];
		if (unique.length === 0) {
			dropped++;
			continue;
		}

		const id = makeId(options.newId);
		const explanation = undefinedIfBlank(generated.explanation);
		const base = {
			id,
			itemIds: unique,
			...(explanation ? { explanation } : {})
		};

		switch (generated.type) {
			case 'recognize-mc': {
				// The options are native-language meanings, so no reading rides along
				// and no `optionsRomanization` is produced.
				const { options: choices, correctIndex } = assembleChoices(
					[
						{ text: generated.correctMeaning.trim(), correct: true },
						...generated.distractors.map((text) => ({ text: text.trim() }))
					],
					rng
				);
				challenges.push({
					...base,
					type: 'multiple-choice',
					direction: 'toNative',
					prompt: generated.shown.text.trim(),
					...optionalString('promptRomanization', generated.shown.reading),
					options: choices,
					correctIndex,
					...optionalString('instruction', generated.instruction)
				});
				break;
			}

			case 'produce-mc': {
				challenges.push({
					...base,
					type: 'multiple-choice',
					direction: 'toTarget',
					// The prompt is native by construction, so there is no reading to
					// show and none to accidentally spoil the answer with.
					prompt: generated.promptNative.trim(),
					...assembleChoices(
						[
							{
								text: generated.correct.text.trim(),
								reading: readingOf(generated.correct),
								correct: true
							},
							...generated.distractors.map((d) => ({
								text: d.text.trim(),
								reading: readingOf(d)
							}))
						],
						rng
					),
					...optionalString('instruction', generated.instruction)
				});
				break;
			}

			case 'cloze': {
				challenges.push({
					...base,
					type: 'cloze',
					direction: 'toTarget',
					// The halves carry their own spacing and punctuation; concatenating
					// them verbatim is what guarantees exactly one blank, in the one
					// place the answer was taken from.
					sentence: generated.before.text + CLOZE_GAP + generated.after.text,
					...clozeSentenceRomanization(generated),
					acceptedAnswers: answerVariants(generated.answer),
					// Only ever shown *after* answering, which is what makes it safe:
					// `acceptedAnswers[0]` is the answer's own text, so this reading
					// annotates that string and nothing the learner still has to produce.
					...optionalString('answerRomanization', generated.answer.reading),
					...clozeWordBank(generated.answer, generated.distractorWords, rng),
					translationHint: generated.hintNative.trim()
				});
				break;
			}

			case 'translate-to-target': {
				challenges.push({
					...base,
					type: 'typed-translation',
					direction: 'toTarget',
					// No `promptRomanization`: the prompt is native, and the field does
					// not exist on this wire type, so the answer's reading has nowhere
					// to leak to.
					prompt: generated.promptNative.trim(),
					acceptedAnswers: dedupe(generated.answers.flatMap(answerVariants)),
					// The first answer is the canonical one (`answerVariants` puts its
					// text first), so its reading is the one that belongs under the
					// answer the banner shows.
					...optionalString('answerRomanization', generated.answers[0].reading)
				});
				break;
			}

			case 'translate-to-native': {
				challenges.push({
					...base,
					type: 'typed-translation',
					direction: 'toNative',
					prompt: generated.prompt.text.trim(),
					...optionalString('promptRomanization', generated.prompt.reading),
					acceptedAnswers: dedupe(generated.answersNative)
				});
				break;
			}

			case 'word-order': {
				// Structural: fewer than two real tiles is not a sentence to build,
				// and a blank tile is a tile that cannot be tapped. Punctuation-only
				// tiles ("？" as its own tile) are merged into their neighbour first —
				// forgetting a question mark is not a language mistake, so it must
				// not be a placeable, gradeable tile.
				const raw = tokenize(generated.words);
				const words = raw && mergePunctuationTokens(raw);
				if (!words || words.length < 2) {
					dropped++;
					continue;
				}

				// Distractors are cosmetic: an oversized list is trimmed, and one that
				// duplicates a real tile is dropped — it could only ever be used in
				// place of its twin, which grades correct anyway (text sequence, not
				// indices), so it is a tile that does nothing. The allowance shrinks
				// as the sentence grows, so an overshot sentence is not padded past
				// MAX_WORD_ORDER_TILES into a search puzzle.
				const allowance = Math.min(
					MAX_WORD_ORDER_DISTRACTORS,
					Math.max(0, MAX_WORD_ORDER_TILES - words.length)
				);
				const seen = new Set(words.map((word) => labelKey(word.text)));
				const distractors: Token[] = [];
				for (const candidate of generated.distractorWords ?? []) {
					if (distractors.length >= allowance) break;
					const token = { text: candidate.text.trim(), reading: readingOf(candidate) };
					const key = labelKey(token.text);
					if (!key || seen.has(key) || isPunctuationOnly(token.text)) continue;
					seen.add(key);
					distractors.push(token);
				}

				const tiles = shuffled([...words, ...distractors], rng);
				const answerTokens = words.map((word) => word.text);
				const answerReadings = words.map((word) => word.reading);

				challenges.push({
					...base,
					type: 'word-order',
					direction: 'toTarget',
					// Native by construction: there is no reading to leak the sentence.
					prompt: generated.promptNative.trim(),
					tiles: tiles.map((tile) => tile.text),
					...tokenReadings('tilesRomanization', tiles),
					answerTokens,
					// The script decides the spacing, once, here — so the sentence the
					// banner prints is byte-identical to the one the component assembles
					// out of the learner's tiles.
					answer: joinTokens(answerTokens),
					...(answerReadings.every((reading): reading is string => !!reading)
						? { answerRomanization: answerReadings.join(' ') }
						: {}),
					...optionalString('instruction', generated.instruction)
				});
				break;
			}

			case 'spot-error': {
				const words = tokenize(generated.words);
				const wrong: Token = {
					text: generated.wrongWord.text.trim(),
					reading: readingOf(generated.wrongWord)
				};
				const at = generated.wrongPosition;
				// All structural: a corruption that lands outside the sentence, or one
				// that replaces a word with itself, leaves nothing to find. There is no
				// cosmetic reading of either — the challenge would be unanswerable.
				if (!words || words.length < 3 || at >= words.length || !wrong.text) {
					dropped++;
					continue;
				}
				if (labelKey(wrong.text) === labelKey(words[at].text)) {
					dropped++;
					continue;
				}

				const tokens = words.map((word, index) => (index === at ? wrong : word));

				challenges.push({
					...base,
					type: 'spot-error',
					// The sentence is target-language and the meaning is given; the
					// learner is reading *out* of the target language to find the slip.
					direction: 'toNative',
					tokens: tokens.map((token) => token.text),
					...tokenReadings('tokensRomanization', tokens),
					correctIndex: at,
					intendedWord: words[at].text,
					...(words[at].reading ? { intendedWordRomanization: words[at].reading } : {}),
					correctedSentence: joinTokens(words.map((word) => word.text)),
					meaning: generated.meaningNative.trim()
				});
				break;
			}

			default: {
				const _exhaustive: never = generated;
				void _exhaustive;
			}
		}
	}

	// Never introduce vocabulary the lesson does not actually practise.
	const keptItems = newItems.filter((_, index) => usedNewIndexes.has(index));

	return { challenges, newItems: keptItems, dropped };
}

// --------------------------------------------------------------------------
// The call
// --------------------------------------------------------------------------

/**
 * Generates one lesson batch.
 *
 * A single completion with the batch JSON schema attached; the reply is parsed
 * leniently (fences stripped, bad entries dropped). If too few challenges
 * survive, one corrective retry is made, after which it gives up with
 * `LlmError('bad-response')`.
 *
 * Remember: returned `newItems` carry `fsrsCard: null` for the caller to fill.
 */
export async function generateBatch(args: BatchArgs, opts: BatchOptions = {}): Promise<BatchResult> {
	const progress = opts.onProgress;
	progress?.({ id: 'build-prompt', label: 'Building the prompt' });
	const messages = buildBatchPrompt(args);
	const model = opts.model?.trim() || getModel();
	const requested =
		args.count ?? defaultChallengeCount(args.reviewItems.length, args.newItemSlots);
	// A two-challenge batch can never reach five; do not demand the impossible.
	const minimum = Math.min(MIN_BATCH_CHALLENGES, Math.min(requested, MAX_BATCH_CHALLENGES));
	const knownItemIds = args.reviewItems.map((i) => i.id);
	const termToId = knownTermIndex(args);

	const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
	let lastError: LlmError | undefined;

	for (let attempt = 0; attempt < 2; attempt++) {
		const attemptMessages: ChatMessage[] =
			attempt === 0
				? messages
				: [...messages, { role: 'user', content: CORRECTIVE_INSTRUCTION }];

		if (attempt > 0) progress?.({ id: 'retry', label: 'Retrying generation' });
		progress?.({ id: 'request', label: `Waiting for ${model}` });

		const completion = await chatCompletion({
			messages: attemptMessages,
			model: opts.model,
			apiKey: opts.apiKey,
			signal: opts.signal,
			fetchFn: opts.fetchFn,
			responseFormat: { name: BATCH_SCHEMA_NAME, schema: batchJsonSchema() },
			temperature: 0.7
		});
		usage.promptTokens += completion.usage.promptTokens;
		usage.completionTokens += completion.usage.completionTokens;

		progress?.({ id: 'validate', label: 'Validating challenges' });

		let resolved: ResolvedBatch;
		try {
			resolved = resolveBatch(parseBatch(completion.content), {
				newId: opts.newId,
				now: opts.now,
				knownItemIds,
				termToId,
				rng: opts.rng
			});
		} catch (error) {
			if (error instanceof LlmError && error.kind === 'bad-response') {
				lastError = error;
				continue;
			}
			throw error;
		}

		if (resolved.challenges.length >= minimum) {
			return { challenges: resolved.challenges, newItems: resolved.newItems, usage };
		}
		lastError = new LlmError(
			'bad-response',
			`The model only produced ${resolved.challenges.length} usable challenge(s). Try again.`
		);
	}

	throw (
		lastError ??
		new LlmError('bad-response', 'The model returned no usable challenges. Try again.')
	);
}

// --------------------------------------------------------------------------
// Zero-token local generation
// --------------------------------------------------------------------------

/** Smallest and largest pair count for a locally built match-pairs round. */
const MATCH_MIN = 4;
const MATCH_MAX = 5;

/**
 * Builds a `match-pairs` challenge locally, for free — no model call, no
 * tokens. Pairs a random handful of already-known items term-to-meaning.
 *
 * **Every tile label is unique.** Two items that render the same text on either
 * side (two synonyms sharing a meaning, two spellings sharing a term) make the
 * round unplayable: the learner sees two identical tiles and has to guess which
 * twin belongs to which pair, and a correct guess is graded wrong half the time.
 * The first item of a colliding group is kept and the rest are skipped, matched
 * case-insensitively on trimmed text.
 *
 * Returns `undefined` when fewer than four collision-free items remain.
 *
 * @param rng Injectable `[0,1)` source so tests (and replays) are deterministic.
 */
export function makeMatchPairsChallenge(
	items: KnowledgeItem[],
	rng: () => number = Math.random
): Challenge | undefined {
	const usable = items.filter((i) => i.term?.trim() && i.meaning?.trim());
	if (usable.length < MATCH_MIN) return undefined;

	const pool = shuffled(usable, rng);

	// Drop collisions *after* the shuffle, so which twin survives is still
	// random rather than always the first one in storage order.
	const seenTerms = new Set<string>();
	const seenMeanings = new Set<string>();
	const distinct: KnowledgeItem[] = [];
	for (const item of pool) {
		const term = labelKey(item.term);
		const meaning = labelKey(item.meaning);
		if (seenTerms.has(term) || seenMeanings.has(meaning)) continue;
		seenTerms.add(term);
		seenMeanings.add(meaning);
		distinct.push(item);
	}
	if (distinct.length < MATCH_MIN) return undefined;

	const max = Math.min(MATCH_MAX, distinct.length);
	const size = max > MATCH_MIN ? MATCH_MIN + Math.floor(rng() * (max - MATCH_MIN + 1)) : MATCH_MIN;
	const chosen = distinct.slice(0, Math.min(size, max));

	return {
		id: makeId(),
		type: 'match-pairs',
		direction: 'toNative',
		itemIds: chosen.map((i) => i.id),
		// `aRom` carries the term's romanization when the item has one; `b` is
		// already in the learner's native language, so it never needs one.
		pairs: chosen.map((i) => ({
			a: i.term.trim(),
			b: i.meaning.trim(),
			...optionalString('aRom', i.romanization)
		}))
	};
}
