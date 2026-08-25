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
 *
 * What it deliberately does *not* know is the challenge types. Each wire type
 * owns its schema, its prompt line, its corrective line and its resolver in
 * `./challenge-types/<type>.ts`; this module composes the prompt out of the
 * registry and dispatches to it, and even `generatedChallengeSchema` — imported
 * below from `./schemas` — is a projection of that same registry. The pipeline
 * it keeps for itself is the part
 * that is the same for every type: the call and its one corrective retry,
 * salvage-parsing, id minting, `new:<index>` and term-citation resolution, and
 * counting what had to be dropped.
 */

import { getModel } from '$lib/db/settings';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import {
	WIRE_TYPE_DEFS,
	byType,
	clozeDef,
	spotErrorDef,
	translateToTargetDef,
	wordOrderDef
} from './challenge-types';
import type { ChallengeBase, ResolveContext } from './challenge-types';
import { chatCompletion, LlmError } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';
import { labelKey, optionalString, shuffled, undefinedIfBlank } from './resolve-helpers';
import {
	BATCH_SCHEMA_NAME,
	NEW_ITEM_REF,
	batchJsonSchema,
	generatedChallengeSchema,
	generatedItemSchema,
	looseBatchSchema
} from './schemas';
import type { GeneratedChallenge, GeneratedItem } from './schemas';

/**
 * Re-exported for callers (and tests) that knew them as part of this module
 * before the per-type defs moved out to `./challenge-types`. Their home is
 * `./resolve-helpers`.
 */
export { MAX_WORD_ORDER_DISTRACTORS, MAX_WORD_ORDER_TILES } from './resolve-helpers';

/** Hard ceiling on challenges per batch, so one call can never run away. */
export const MAX_BATCH_CHALLENGES = 20;

/** Below this many salvaged challenges a batch is not worth playing. */
export const MIN_BATCH_CHALLENGES = 5;

export interface ReviewItemRef {
	id: string;
	term: string;
	meaning: string;
	/**
	 * How far along this word is — a hint for *which types* to write about it.
	 *
	 * Free production is a much harder question than recognition, and a word met
	 * yesterday put through one produces a wrong answer that says nothing about
	 * the word. The caller derives this from the same strength floors the session
	 * planner gates serving on (`maturityOf` in `$lib/session/progression`), so
	 * the two halves agree: the prompt asks for recognition where the planner
	 * would only serve recognition anyway.
	 *
	 * Optional and omitted rather than sent blank — a caller with no SRS state to
	 * consult pays nothing for the field, and the mock ignores it entirely.
	 */
	maturity?: 'new' | 'young' | 'solid';
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
 *
 * The `Types:` block is composed from the wire-type registry
 * (`./challenge-types`), so a type's field list and example live in the same
 * module as the zod schema they describe and the resolver that consumes it, and
 * the three cannot drift apart — describing a field the schema will reject is
 * one edit away from impossible. In `Rules:` only the four rules
 * that name a single type do — the rest span types (segmentation covers
 * word-order *and* spot-error; the never-swap-sides rule enumerates six fields
 * across five types) and splitting them up would cost tokens to say the same
 * thing several times.
 */
const SYSTEM_PROMPT = [
	'You are an expert language-course author. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"challenges":[Challenge],"newItems":[{"term","meaning","romanization","notes"}]}',
	'Every Challenge has: type, itemIds, explanation (one short sentence or null). The rest of its fields depend on the type.',
	'TargetText, written {"text":..,"reading":..}, is one string of the TARGET language plus its Latin reading: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. "reading" is ALWAYS null when the target language is written in the Latin script. Every field that is not a TargetText is plain text in the NATIVE language.',
	'Types:',
	...WIRE_TYPE_DEFS.map((def) => def.promptSpec),
	'Rules:',
	'- itemIds: the id of a reviewItem, "new:<index>" for an entry of newItems (0-based), or — for a challenge built on a word from known — that word exactly as it appears in known. Never invent anything else.',
	'- Produce exactly one challenge object per requested slot; give the same review item different types.',
	'- Mix recognition and production across the batch.',
	'- Match type to maturity ("maturity" on each reviewItem): new → recognize-mc, produce-mc, translate-to-native, spot-error, cloze WITH distractorWords; young adds word-order; solid adds translate-to-target and cloze without distractorWords. A new word\'s first challenges must be recognition.',
	'- Distractors must be plausible: same part of speech and register, never synonyms of the correct answer, never obviously absurd. Exactly one of the four may be correct given the prompt; if two would both answer it, rewrite the prompt.',
	'- Sides never swap: correctMeaning, recognize-mc distractors, promptNative, hintNative, meaningNative, answersNative and instruction are NATIVE-language text and never contain target-language words or script. A challenge whose prompt and options are in the same language is invalid — one side is always the native language.',
	translateToTargetDef.rulesSpec,
	'- Answerable from what is shown alone: the prompt, plus the challenge type, must uniquely determine the answer. Never an open question whose answer depends on facts you never state — directions, prices, names, times, opinions, anything from an imagined scene the learner cannot see.',
	'- In a situational dialogue either give the exact line to produce ("Say: \'the fish stall is to the right\'") or make answers cover every plausible alternative reply.',
	'- instruction: a short heading, in the NATIVE language, matched to what the challenge actually asks — "What does this mean?" for a plain meaning question, "Pick the best reply" or "How would you answer?" for a conversational turn; null when the default meaning-question heading fits.',
	clozeDef.rulesSpec,
	'- Segmentation (word-order, spot-error): one tile per WORD, never per character or syllable, and punctuation rides on the tile it touches — never a tile of its own ("吗？" is one tile, "？" alone is not a tile). For Chinese and Japanese split on word boundaries — 菜单 is one tile, not 菜 + 单. Each tile is a TargetText and carries its own reading under the usual rule.',
	wordOrderDef.rulesSpec,
	spotErrorDef.rulesSpec,
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
]
	// `rulesSpec` is optional — a wire type with no rule of its own contributes
	// no line, rather than a blank one the model would have to read past.
	.filter((line): line is string => line !== undefined)
	.join('\n');

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
		reviewItems: reviewItems.map((i) => ({
			id: i.id,
			t: i.term,
			m: i.meaning,
			// Spelled out rather than abbreviated like `t`/`m`: the rule that reads it
			// names the field, and a dozen review items make the difference a rounding
			// error against a 1450-token static prompt.
			...(i.maturity ? { maturity: i.maturity } : {})
		})),
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

/**
 * Appended verbatim when a first attempt came back mostly unusable.
 *
 * A second, much terser pass at the same field lists: by the time this is sent
 * the model has already ignored the schema once, so it restates only the
 * *required* fields — no examples, no optional keys. The per-type fragments come
 * from the registry in the same order as the prompt's `Types:` block.
 */
export const CORRECTIVE_INSTRUCTION =
	'Your previous reply was rejected. Return ONLY a raw JSON object {"challenges":[...],"newItems":[...]}, no fences, no commentary. Every challenge needs type, itemIds and its own fields: ' +
	WIRE_TYPE_DEFS.map((def) => def.correctiveSpec).join(', ') +
	'. Every target-language slot is a TargetText object {"text","reading"}, reading null for Latin scripts; distractors is exactly 3 entries.';

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
 * Hands one validated payload to the def that owns its type; `null` means drop
 * it (see {@link WireTypeDef.resolve}).
 *
 * The cast is the price of dispatching a union value through a union of defs:
 * TypeScript will not pair the two up on its own, and there is no runtime check
 * that would make it. What makes the pairing true is `_registryParity` in
 * `./challenge-types`, which fails `pnpm check` the moment a wire type has no
 * def — or a def has no wire type.
 */
function resolveOne(generated: GeneratedChallenge, ctx: ResolveContext): Challenge | null {
	const def = byType.get(generated.type);
	// Unreachable by construction, and deliberately not a throw: a lookup miss
	// would mean a whole paid-for batch dies over one unknown type.
	if (!def) return null;
	const resolve = def.resolve as (g: GeneratedChallenge, c: ResolveContext) => Challenge | null;
	return resolve(generated, ctx);
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
		const base: ChallengeBase = {
			id,
			itemIds: unique,
			...(explanation ? { explanation } : {})
		};

		const resolved = resolveOne(generated, { base, rng });
		if (!resolved) {
			dropped++;
			continue;
		}
		challenges.push(resolved);
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
