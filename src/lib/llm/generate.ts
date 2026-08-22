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
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
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
import type { GeneratedChallenge, GeneratedItem } from './schemas';

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

export type BatchProfile = Pick<
	Profile,
	'nativeLanguage' | 'targetLanguage' | 'level' | 'interests'
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
 * inline example per challenge type, rules as bare imperatives. Roughly 1050
 * prompt tokens (up from ~480 before the voice, romanization and calibration
 * blocks below),
 * unchanged across every call, so it caches well on providers that support
 * prompt caching — and it buys back more than it costs: better challenges mean
 * fewer regenerated batches, and the romanization rules keep grading local.
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
 *   beginner. The model must supply a Latin reading for every target-script
 *   string, *and* put the toneless romanization into `acceptedAnswers` so the
 *   local (free) validator grades "ni hao" as correct without any script-aware
 *   logic of its own. Latin-script targets omit the fields entirely and pay
 *   nothing.
 */
const SYSTEM_PROMPT = [
	'You are an expert language-course author. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"challenges":[Challenge],"newItems":[{"term","meaning","romanization","notes"}]}',
	'Every Challenge has: type, direction ("toTarget"=produce the target language, "toNative"=produce the native language), itemIds, explanation (one short sentence or null).',
	'Types:',
	'multiple-choice {prompt, options:[4 strings], correctIndex:0-3, promptRomanization, optionsRomanization, instruction} e.g. {"type":"multiple-choice","direction":"toNative","prompt":"el perro","options":["the dog","the cat","the bread","the house"],"correctIndex":0,"itemIds":["i1"],"explanation":null,"instruction":null}',
	'cloze {sentence (must contain ___), acceptedAnswers, wordBank (4-6 candidate words or null), translationHint, sentenceRomanization} e.g. {"type":"cloze","direction":"toTarget","sentence":"Yo ___ un libro.","acceptedAnswers":["leo"],"wordBank":["leo","como","bebo","corro"],"translationHint":"I read a book.","itemIds":["i2"],"explanation":"leer -> leo in the first person."}',
	'typed-translation {prompt, acceptedAnswers, promptRomanization} e.g. {"type":"typed-translation","direction":"toTarget","prompt":"the water is cold","acceptedAnswers":["el agua esta fria","el agua está fría"],"itemIds":["new:0"],"explanation":null}',
	'Rules:',
	'- itemIds must reference the given item ids, or "new:<index>" for entries of newItems (0-based). Never invent an id.',
	'- Produce exactly one challenge object per requested slot; give the same review item different types.',
	'- Distractors must be plausible: same part of speech and register, never synonyms of the answer, never obviously absurd.',
	'- acceptedAnswers must be exhaustive: with and without accents, with and without the article, contractions, and every common synonym or word order a learner might type.',
	'- Mix direction across the batch.',
	'- Cloze sentences use only vocabulary at or below the learner level, keep one blank, and translationHint is the whole sentence in the native language. If sentenceRomanization is given it must keep the ___ gap (see Romanization).',
	'- Answerable from what is shown alone: the prompt, plus the challenge type, must uniquely determine the answer. Never an open question whose answer depends on facts you never state — directions, prices, names, times, opinions, anything from an imagined scene the learner cannot see.',
	'- In a situational dialogue either give the exact line to produce ("Say: \'the fish stall is to the right\'") or make acceptedAnswers cover every plausible alternative reply.',
	'- Multiple-choice: exactly one option may be correct given the prompt; if two options would both answer it, rewrite the prompt.',
	'- instruction: a short heading, in the NATIVE language, matched to what the challenge actually asks — "What does this mean?" for a plain meaning question, "Pick the best reply" or "How would you answer?" for a conversational turn; null when the default meaning-question heading fits.',
	'- newItems must fit the learner level; term in the target language, meaning in the native language, notes only for gender/irregularity/register.',
	'- Exactly newItemSlots entries in newItems, and every one of them must be used by at least one challenge.',
	'Difficulty calibration:',
	'- recentAccuracy (0-1, share of recent answers the learner got right) and recentMistakes are their current form; calibrate the batch to them.',
	'- recentAccuracy below 0.7: favour recognition — multiple-choice and cloze WITH a wordBank — keep answers to one or two words, and avoid full-sentence typed-translation.',
	'- recentAccuracy above 0.85: lean into production — typed-translation and cloze without a wordBank, longer sentences.',
	'- Every term in recentMistakes gets one more challenge in this batch, EASIER than last time and in a different format from the one it was failed in.',
	'- gave "(skipped)" means the format was too demanding for that term: re-practise it with a recognition format.',
	'Voice:',
	'- Conversation, not flashcards: every prompt, sentence and translation is a line someone would really say — a dialogue turn, a question put to the learner, a request, a reaction, an opinion. Never an isolated textbook statement.',
	'- With a "topic", EVERY challenge happens inside that scenario: cloze sentences are turns of that dialogue, translations are things you would really say there, newItems are words the scenario needs. "interests" then only colour word choice, never the sentence frame.',
	'- Banned: "I like <interest>", "<interest> is fun", any sentence whose only content is that the learner likes their interest, and reusing a sentence frame twice in one batch. Vary speaker, question vs statement, and register for the level.',
	'- explanation: one line of usage or culture (register, politeness, word order) when non-obvious, written in the NATIVE language (target-language words may be quoted inside it); null when it would only restate the answer.',
	'Romanization, for target languages NOT written in the Latin script only:',
	'- Give a Latin reading for every target-script string: promptRomanization, optionsRomanization (one per option, same order), sentenceRomanization (whole sentence), newItems.romanization. Use pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise.',
	'- sentenceRomanization mirrors the cloze sentence INCLUDING the ___ gap: romanize only the words that are visible, leave ___ exactly where it stands, and never write the reading of the blanked word — that hands the learner the answer. e.g. sentence "你好，请给我一份___。" -> sentenceRomanization "Nǐ hǎo, qǐng gěi wǒ yī fèn ___."',
	'- A field whose string is already in the native language is null.',
	'- For typed answers (cloze without wordBank, typed-translation toTarget) acceptedAnswers must ALSO list the romanized form with AND without tone/accent marks, e.g. ["你好","nǐ hǎo","ni hao"].',
	'- If the target language uses the Latin script, every romanization field is null.'
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

	const payload: Record<string, unknown> = {
		native: profile.nativeLanguage,
		target: profile.targetLanguage,
		level: profile.level,
		// Placed before `interests` on purpose: the scenario outranks the
		// interests, and models weight earlier keys more heavily.
		...(topic ? { topic } : {}),
		interests: profile.interests,
		challengeCount: Math.min(count, MAX_BATCH_CHALLENGES),
		newItemSlots,
		reviewItems: reviewItems.map((i) => ({ id: i.id, t: i.term, m: i.meaning }))
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
	'Your previous reply was rejected. Return ONLY a raw JSON object {"challenges":[...],"newItems":[...]}, no fences, no commentary. Every challenge needs type, direction, itemIds and its own required fields; cloze sentences must contain ___; multiple-choice needs exactly 4 options.';

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

/**
 * Keeps a cloze's `sentenceRomanization` only when it still hides the answer.
 *
 * A reading that dropped the `___` has, in practice, romanized the blanked word
 * along with the rest of the sentence — so a learner with romanization switched
 * on is handed the answer they were asked to produce. The reading is worth much
 * less than the challenge, so the field goes and the challenge stays.
 */
function clozeRomanization(
	sentence: string,
	romanization: string | null | undefined
): Partial<Record<'sentenceRomanization', string>> {
	const trimmed = undefinedIfBlank(romanization);
	if (!trimmed) return {};
	if (sentence.includes(CLOZE_GAP) && !trimmed.includes(CLOZE_GAP)) return {};
	return { sentenceRomanization: trimmed };
}

/**
 * Keeps a romanization array only when it lines up with the strings it
 * annotates, one non-blank entry each. A misaligned array would put the wrong
 * reading under the wrong option, which is worse than showing none.
 */
function alignedRomanization(
	values: string[] | null | undefined,
	expectedLength: number
): string[] | undefined {
	if (!values || values.length !== expectedLength) return undefined;
	const trimmed = values.map((v) => v.trim());
	return trimmed.every((v) => v.length > 0) ? trimmed : undefined;
}

export interface ResolveOptions {
	newId?: () => string;
	now?: () => number;
	/** Ids the model was allowed to reference. Omit to accept any non-`new:` id. */
	knownItemIds?: Iterable<string>;
}

export interface ResolvedBatch {
	challenges: Challenge[];
	newItems: KnowledgeItem[];
	/** Challenges discarded because none of their itemIds resolved. */
	dropped: number;
}

/**
 * Turns validated model output into domain objects: mints challenge ids,
 * materializes `newItems` as `KnowledgeItem`s and rewrites every `new:<index>`
 * reference to the real id.
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
			direction: generated.direction,
			itemIds: unique,
			...(explanation ? { explanation } : {})
		};

		if (generated.type === 'multiple-choice') {
			const [a, b, c, d] = generated.options;
			const optionsRomanization = alignedRomanization(generated.optionsRomanization, 4);
			challenges.push({
				...base,
				type: 'multiple-choice',
				prompt: generated.prompt,
				...optionalString('promptRomanization', generated.promptRomanization),
				options: [a, b, c, d],
				...(optionsRomanization ? { optionsRomanization } : {}),
				correctIndex: generated.correctIndex,
				...optionalString('instruction', generated.instruction)
			});
		} else if (generated.type === 'cloze') {
			const wordBank = generated.wordBank?.filter((w) => w.trim().length > 0);
			challenges.push({
				...base,
				type: 'cloze',
				sentence: generated.sentence,
				...clozeRomanization(generated.sentence, generated.sentenceRomanization),
				acceptedAnswers: generated.acceptedAnswers,
				...(wordBank && wordBank.length > 1 ? { wordBank } : {}),
				translationHint: generated.translationHint
			});
		} else {
			challenges.push({
				...base,
				type: 'typed-translation',
				prompt: generated.prompt,
				...optionalString('promptRomanization', generated.promptRomanization),
				acceptedAnswers: generated.acceptedAnswers
			});
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
				knownItemIds
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

/** Case- and whitespace-insensitive key used to detect colliding tile labels. */
function tileKey(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

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

	// Fisher-Yates over a copy.
	const pool = [...usable];
	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[pool[i], pool[j]] = [pool[j], pool[i]];
	}

	// Drop collisions *after* the shuffle, so which twin survives is still
	// random rather than always the first one in storage order.
	const seenTerms = new Set<string>();
	const seenMeanings = new Set<string>();
	const distinct: KnowledgeItem[] = [];
	for (const item of pool) {
		const term = tileKey(item.term);
		const meaning = tileKey(item.meaning);
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
