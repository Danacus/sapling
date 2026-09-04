/**
 * Batch generation: turn the learner's profile plus the words their schedule
 * has reached into a playable set of challenges.
 *
 * A batch is drilling practice for vocabulary the learner already has, and it
 * introduces none of its own — new words enter the collection through the
 * assistant's `add_words` tool (`$lib/assistant`, `$lib/conversation`), which
 * is a different job and a different conversation. Everything the model is told
 * about words, it is told so that it can *write about* them.
 *
 * This is the token-economy heart of the app. A lesson is a handful of small
 * concurrent calls; grading happens locally for free (`$lib/validate`,
 * `$lib/srs`) and only an explicit "explain this" escalates to a second call
 * (`./escalation`). `match-pairs` never costs a token at all — see
 * {@link makeMatchPairsChallenge}.
 *
 * **A lesson is many short requests, not one long one.** Asking for twenty
 * challenges about twelve words in a single completion produced visibly worse
 * output towards the end: the model loses track of the rules and of what it has
 * already written, one bad reply costs the whole lesson a corrective retry, and
 * the wall clock is one long serial completion. So {@link planSlots} decides
 * locally *which* challenges the lesson is made of, {@link chunkSlots} cuts that
 * plan into requests of a few slots about a few words, and {@link generateBatch}
 * runs them concurrently against the *same static* `SYSTEM_PROMPT` — static
 * because that is what keeps prompt caching paying for itself across chunks and
 * across sessions. Each chunk carries its own corrective retry, and a chunk that
 * still fails is **dropped, not fatal**: the lesson is whatever came back, and
 * only a merged total below {@link MIN_BATCH_CHALLENGES} is an error.
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
 * that is the same for every type: the calls and their corrective retries,
 * salvage-parsing, id minting, term-citation resolution, and counting what had
 * to be dropped.
 */

import { getModel } from '$lib/db/settings';
import { termKey } from '$lib/text';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import {
	WIRE_TYPE_DEFS,
	byType,
	clozeDef,
	produceMcDef,
	recognizeMcDef,
	spotErrorDef,
	translateToNativeDef,
	translateToTargetDef,
	wordOrderDef
} from './challenge-types';
import type { ChallengeBase, ResolveContext } from './challenge-types';
import { chatCompletion, LlmError } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';
import { labelKey, optionalString, shuffled, undefinedIfBlank } from './resolve-helpers';
import {
	BATCH_SCHEMA_NAME,
	batchJsonSchema,
	generatedChallengeSchema,
	looseBatchSchema
} from './schemas';
import type { GeneratedChallenge } from './schemas';
import { CHUNK_CONCURRENCY, MAX_BATCH_CHALLENGES, chunkSlots, planSlots } from './slots';
import type { SlotChunk } from './slots';

/**
 * Re-exported for callers (and tests) that knew them as part of this module
 * before the per-type defs moved out to `./challenge-types`. Their home is
 * `./resolve-helpers`.
 */
export { MAX_WORD_ORDER_DISTRACTORS, MAX_WORD_ORDER_TILES } from './resolve-helpers';

/**
 * Re-exported for the same reason: how big a lesson is belongs with the planner
 * that lays it out (`./slots`), but every caller has always asked this module.
 */
export { MAX_BATCH_CHALLENGES, defaultChallengeCount } from './slots';

/** Below this many salvaged challenges across all chunks a lesson is not worth playing. */
export const MIN_BATCH_CHALLENGES = 5;

/** One word the batch is to be written about: the id, the word, its meaning. */
export interface ReviewItemRef {
	id: string;
	term: string;
	meaning: string;
	/**
	 * How far along this word is on the five-rung ladder, 1..5 — a hint for
	 * *which types* to write about it and *how hard* to write them.
	 *
	 * Free production is a much harder question than recognition, and a word met
	 * yesterday put through one produces a wrong answer that says nothing about
	 * the word. The caller derives this from the same strength floors the session
	 * planner gates serving on (`difficultyLevelOf` in `$lib/session/progression`
	 * — a bare `1..5` here rather than an imported type, since `$lib/llm` never
	 * reaches into `$lib/session`), so the two halves agree: the prompt asks for
	 * recognition where the planner would only serve recognition anyway.
	 * `./slots` also folds it into every slot's own `difficulty`.
	 *
	 * Optional and omitted rather than sent blank — a caller with no SRS state to
	 * consult pays nothing for the field, and the mock ignores it entirely.
	 */
	level?: 1 | 2 | 3 | 4 | 5;
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
 *
 * A lesson is several concurrent requests, and the list stays **one step per
 * id** regardless: `request` fires once and says how many calls are in flight,
 * `retry` fires once the first time any of them has to be re-asked, and
 * `validate` fires once when they have all settled. The learn screen times each
 * step from its event to the next, so a step per chunk would turn a truthful
 * timeline into a flickering list of near-zero durations.
 */
export type ProgressStepId =
	'queue-check' | 'select-items' | 'build-prompt' | 'request' | 'validate' | 'retry' | 'save';

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
	/**
	 * The words this batch is for: what the SRS says is due, topped up with what
	 * comes due soonest (see `selectSessionItems`). Every challenge should
	 * exercise one of them — they are the subject of the lesson, and a batch has
	 * no other source of vocabulary.
	 */
	reviewItems: ReviewItemRef[];
	recentMistakes?: RecentMistake[];
	/**
	 * Share of recent reviews the learner got right, 0..1 — a difficulty dial, but
	 * a *local* one now: `./slots` reads it to shift every slot's `difficulty` and
	 * to move `productionShare`, and neither number ever reaches the model as
	 * `recentAccuracy` itself. Absent on day one, when there is no history to
	 * judge by.
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
	 * Every item the learner already has, whether or not this batch is aimed at
	 * it. Two jobs: sentences should prefer drawing on these, so a challenge is
	 * mostly made of words the learner can already read instead of untracked
	 * strangers; and a challenge built on one of them may cite it in `itemIds`
	 * **by its term** — the resolver maps terms back to ids locally.
	 *
	 * Only the terms travel in the prompt (a few hundred words costs well under
	 * 1k tokens, paid only on explicit generation) — bare, except where two of
	 * them share a spelling and a reading has to say which is which
	 * ({@link knownTermLabels}). The ids stay on this side: the model never sees
	 * them, so it cannot be asked to echo them back — that is exactly why term
	 * citations must be legal. See {@link knownTermIndex}.
	 */
	knownItems?: KnownItemRef[];
}

/** One already-known word: the id the app uses, the term the model sees. */
export interface KnownItemRef {
	id: string;
	term: string;
	/**
	 * The word's reading, when it has one — sent to the model *only* when the
	 * collection holds another word spelled the same way. See
	 * {@link knownTermLabels}.
	 */
	romanization?: string;
}

export interface BatchOptions {
	fetchFn?: FetchLike;
	model?: string;
	apiKey?: string;
	signal?: AbortSignal;
	/** Injectable id factory; defaults to `crypto.randomUUID()`. */
	newId?: () => string;
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
	usage: TokenUsage;
}

// --------------------------------------------------------------------------
// Prompt
// --------------------------------------------------------------------------

/**
 * The system prompt. Written for tokens, not for looks: no pleasantries, one
 * inline example per challenge type, rules as bare imperatives. Unchanged across
 * every call — and now across every *chunk* of every call, which is what makes
 * the chunked design cheap: a lesson's four or five requests all quote the same
 * cached prefix and differ only in a short user message. It buys back more than
 * it costs: better challenges mean fewer regenerated batches, and the
 * content-only wire format keeps grading local.
 *
 * It no longer says which type to write, or how hard by way of an accuracy
 * threshold. Type selection — level floors, the recognition/production mix, the
 * extra go a just-failed word earns — and difficulty selection — the ladder
 * level itself, shifted by accuracy and by a recent miss — are both decided
 * locally in `./slots` and arrive as an explicit `slots` list, each entry
 * carrying its own `type` and `difficulty`, so those rules cost nothing per call
 * and are testable. What stays here is calibration of *content* given a slot's
 * `difficulty`: how long an answer should be, how hard a sentence should read —
 * and, per type, exactly which observable knob to turn (`./challenge-types`'
 * own gradient line for each).
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
 * one edit away from impossible. In `Rules:`, every def's `rulesSpec` — its
 * structural rule where it has one (cloze's vocabulary-level rule, word-order's
 * one-natural-order rule, ...) *and* now its own difficulty gradient, the same
 * bullet where the two coexist — is spliced in beside it; only the rules that
 * name no single type stay hand-written here (segmentation covers word-order
 * *and* spot-error; the never-swap-sides rule enumerates six fields across five
 * types) and splitting those up would cost tokens to say the same thing several
 * times.
 */
const SYSTEM_PROMPT = [
	'You are an expert language-course author. Output one JSON object and nothing else: no prose, no markdown fences.',
	'Shape: {"challenges":[Challenge]}',
	'Every Challenge has: type, itemIds, explanation (one short sentence or null). The rest of its fields depend on the type.',
	'TargetText, written {"text":..,"reading":..}, is one string of the TARGET language plus its Latin reading: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. "reading" is ALWAYS null when the target language is written in the Latin script. Every field that is not a TargetText is plain text in the NATIVE language.',
	'Types:',
	...WIRE_TYPE_DEFS.map((def) => def.promptSpec),
	'Rules:',
	'- itemIds: the id of a reviewItem, or — for a challenge built on a word from known — that word exactly as it appears in known, its parenthesised reading included. Never invent anything else.',
	'- A known entry written "word (reading)" is one of two same-spelled words told apart by how it is read; cite it with the parenthesis, but write only the word itself into a sentence.',
	'- slots is the exact lesson to write: produce one challenge object per slot, in the same order, of that slot\'s "type", about the reviewItem its "item" names. Never a type that is not asked for, never an extra challenge, never a slot left unwritten.',
	'- A "cloze" slot with "bank": true has distractorWords; with "bank": false it has none.',
	'- Distractors must be plausible: same part of speech and register, never synonyms of the correct answer, never obviously absurd. Exactly one of the four may be correct given the prompt; if two would both answer it, rewrite the prompt.',
	'- Sides never swap: correctMeaning, recognize-mc distractors, promptNative, hintNative, meaningNative, answersNative and instruction are NATIVE-language text and never contain target-language words or script. A challenge whose prompt and options are in the same language is invalid — one side is always the native language.',
	recognizeMcDef.rulesSpec,
	produceMcDef.rulesSpec,
	translateToTargetDef.rulesSpec,
	translateToNativeDef.rulesSpec,
	'- Answerable from what is shown alone: the prompt, plus the challenge type, must uniquely determine the answer. Never an open question whose answer depends on facts you never state — directions, prices, names, times, opinions, anything from an imagined scene the learner cannot see.',
	'- In a situational dialogue either give the exact line to produce ("Say: \'the fish stall is to the right\'") or make answers cover every plausible alternative reply.',
	'- instruction: a short heading, in the NATIVE language, matched to what the challenge actually asks — "What does this mean?" for a plain meaning question, "Pick the best reply" or "How would you answer?" for a conversational turn; null when the default meaning-question heading fits.',
	clozeDef.rulesSpec,
	'- Segmentation (word-order, spot-error): one tile per WORD, never per character or syllable, and punctuation rides on the tile it touches — never a tile of its own ("吗？" is one tile, "？" alone is not a tile). For Chinese and Japanese split on word boundaries — 菜单 is one tile, not 菜 + 单. Each tile is a TargetText and carries its own reading under the usual rule.',
	wordOrderDef.rulesSpec,
	spotErrorDef.rulesSpec,
	"- known is the learner's whole vocabulary and it is what you build with: every challenge is about a reviewItem, and the words around it come from known, so the learner mostly reads what they can already read. Teach nothing new — a word outside known may appear as glue when a sentence needs it, never as the thing being tested.",
	'Difficulty calibration:',
	'- Each slot carries "difficulty" 1-5, 1 easiest: scale sentence length, glue vocabulary and scaffolding to it — never correctness. Each type above states its own gradient.',
	'- A term in recentMistakes is one the learner just got wrong; write it EASIER than last time, with more of the sentence given.',
	'Voice:',
	'- Conversation, not flashcards: every prompt, sentence and translation is a line someone would really say — a dialogue turn, a question put to the learner, a request, a reaction, an opinion. Never an isolated textbook statement.',
	'- With a "topic", EVERY challenge happens inside that scenario: cloze sentences are turns of that dialogue, translations are things you would really say there, and the reviewItems are worked into it. "interests" then only colour word choice, never the sentence frame.',
	'- "about" is the learner in their own words. Set scenarios in their life — their city, work, people, tastes — and let it colour word choice and examples. Never recite it back to them, never contradict it, and "topic" still outranks it.',
	'- Banned: "I like <interest>", "<interest> is fun", any sentence whose only content is that the learner likes their interest, and reusing a sentence frame twice in one reply. Vary speaker, question vs statement, and register for the level.',
	'- explanation: one line of usage or culture (register, politeness, word order) when non-obvious, written in the NATIVE language (target-language words may be quoted inside it); null when it would only restate the answer.'
]
	// `rulesSpec` is optional — a wire type with no rule of its own contributes
	// no line, rather than a blank one the model would have to read past.
	.filter((line): line is string => line !== undefined)
	.join('\n');

/**
 * How each known word is written into the prompt: bare, or `term (reading)`.
 *
 * A spelling is not a word. 长 is `cháng` ("long") and `zhǎng` ("to grow"), and
 * a learner may hold both as separate cards — so a bare 长 in the known list
 * would be two words the model cannot tell apart, and a challenge citing it
 * could only land on one of them by luck.
 *
 * The qualification is paid for only where it buys something: a term is
 * qualified when the collection holds another word spelled the same way *and*
 * this one has a reading to qualify it with. A learner with no homographs — the
 * overwhelming case — sends exactly the string they sent before, so nothing
 * about prompt size or prompt caching changes for them.
 *
 * The labels are the citation vocabulary too: whatever is rendered here is what
 * {@link knownTermIndex} indexes, so a challenge that cites `长 (zhǎng)` back
 * resolves onto that card and no other.
 */
export function knownTermLabels(known: readonly KnownItemRef[]): string[] {
	const counts = new Map<string, number>();
	for (const item of known) {
		const key = termKey(item.term);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	return known.map((item) => {
		const reading = item.romanization?.trim();
		const ambiguous = (counts.get(termKey(item.term)) ?? 0) > 1;
		return ambiguous && reading ? `${item.term} (${reading})` : item.term;
	});
}

/**
 * Builds the two messages for **one chunk** of a lesson. The user message is
 * compact JSON — no field labels in prose, no restating of the rules.
 *
 * The system half is the same static string for every chunk, so a lesson's four
 * or five requests share one cached prefix and only the short user half differs.
 * That user half is now genuinely short: the `slots` list replaces the paragraph
 * of type-selection *and* difficulty-cliff rules the prompt used to carry —
 * `level` no longer travels at all (it decided the type, and the type is
 * decided; `./slots` folds it into each slot's own `difficulty` instead) and
 * neither does `recentAccuracy` (it only ever fed those same cliffs, and the
 * shift it now applies is entirely local) — and `recentMistakes` is narrowed to
 * the words this chunk is actually about.
 *
 * `known` is *not* narrowed. It is the vocabulary every sentence is built out
 * of, whichever words the chunk is testing, and it is the citation vocabulary
 * the resolver indexes — so it rides along whole, in the same order, on every
 * chunk. That repetition is the price of the split; against the static prompt it
 * is the smaller half.
 */
export function buildChunkPrompt(args: BatchArgs, chunk: SlotChunk): ChatMessage[] {
	const { profile } = args;

	const topic = args.topic?.trim();
	const about = profile.about?.trim().slice(0, MAX_ABOUT_CHARS);
	const chunkTerms = new Set(chunk.reviewItems.map((i) => termKey(i.term)));

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
		reviewItems: chunk.reviewItems.map((i) => ({ id: i.id, t: i.term, m: i.meaning })),
		// The lesson this chunk is: one entry per challenge to write. `bank` rides
		// only on cloze slots, where it is the difference between two exercises.
		slots: chunk.slots.map((slot) => ({
			item: slot.itemId,
			type: slot.type,
			difficulty: slot.difficulty,
			...(slot.bank === undefined ? {} : { bank: slot.bank })
		})),
		// Terms only — the ids stay local (see `knownItems` and `knownTermIndex`).
		...(args.knownItems?.length ? { known: knownTermLabels(args.knownItems) } : {})
	};
	const mistakes = (args.recentMistakes ?? []).filter((m) => chunkTerms.has(termKey(m.term)));
	if (mistakes.length) {
		payload.recentMistakes = mistakes.map((m) => ({ t: m.term, gave: m.gave }));
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
	'Your previous reply was rejected. Return ONLY a raw JSON object {"challenges":[...]}, no fences, no commentary. Every challenge needs type, itemIds and its own fields: ' +
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

	return { challenges, dropped };
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

/**
 * The term → id index {@link resolveBatch} uses to honour term citations in
 * `itemIds`. Built from everything the model saw a term for: the known list
 * (which travels without ids on purpose) and the review items (whose ids the
 * model *was* given, but which it sometimes cites by term anyway — the intent
 * is unambiguous, so honouring it beats dropping a paid-for challenge).
 *
 * A word is indexed under **both** the label it travelled as and its bare term,
 * so `长 (zhǎng)` resolves onto exactly that card while a bare `长` still
 * resolves onto *a* 长. First indexed wins the bare key — deliberately, and it
 * is the reason this needs no cleverer rule: a challenge the model wrote about a
 * homograph without saying which one only vaguely fits either reading, so the
 * review credit landing on the sibling card is a cheaper outcome than dropping a
 * paid-for challenge. Naming the reading is what makes it exact, and the prompt
 * gives the model the means to.
 */
export function knownTermIndex(args: BatchArgs): Map<string, string> {
	const index = new Map<string, string>();
	// Review items first: they are the subject of this batch, so an ambiguous
	// bare citation is likelier to be about one of them than about the rest of
	// the collection.
	for (const item of args.reviewItems) index.set(termKey(item.term), item.id);

	const known = args.knownItems ?? [];
	const labels = knownTermLabels(known);
	known.forEach((item, i) => {
		const bare = termKey(item.term);
		if (!index.has(bare)) index.set(bare, item.id);
		const label = termKey(labels[i]);
		if (label !== bare) index.set(label, item.id);
	});
	return index;
}

export interface ResolveOptions {
	newId?: () => string;
	/** Ids the model was allowed to reference. Omit to accept any id it gives. */
	knownItemIds?: Iterable<string>;
	/**
	 * Term → item id, for references the model makes *by term*. Known words
	 * travel to the model as terms (their ids never leave this side to keep the
	 * prompt cheap), so a challenge built on one can only cite the term — bare,
	 * or `term (reading)` where the spelling alone would be ambiguous. See
	 * {@link knownTermIndex}, which builds this from the batch args.
	 */
	termToId?: ReadonlyMap<string, string>;
	/** Injectable `[0,1)` source for the shuffles; defaults to `Math.random`. */
	rng?: () => number;
}

export interface ResolvedBatch {
	challenges: Challenge[];
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
 * resolves every `itemIds` reference onto a word the learner actually has —
 * and assembles the presentation the model was never asked for.
 *
 * That assembly is where the wire format pays off. The model supplies content;
 * this function decides direction, option order, the position of the blank and
 * which readings are safe to show, so the failure modes that presentation
 * invites (a correct answer always in slot A, a romanization that spells out the
 * word behind the blank, a reading under the wrong option) cannot be expressed
 * in the first place.
 *
 * **Nothing here creates vocabulary.** A reference that is neither a known id
 * nor a known term is simply not carried, and a challenge left with no
 * references at all is dropped — which is what keeps a batch from pooling a row
 * that points at a word the database has never heard of.
 *
 * Salvage philosophy is unchanged: a cosmetic defect — a missing or partial
 * reading, a word bank that dedupes down to nothing — degrades silently, and
 * only a structural failure (no resolvable `itemIds`) costs a challenge.
 *
 * Mock generation runs through this exact function, so the mock exercises the
 * real code path.
 */
export function resolveBatch(batch: ParsedBatch, options: ResolveOptions = {}): ResolvedBatch {
	const known = options.knownItemIds ? new Set(options.knownItemIds) : undefined;
	const rng = options.rng ?? Math.random;

	const challenges: Challenge[] = [];
	let dropped = 0;

	for (const generated of batch.challenges) {
		const itemIds: string[] = [];
		for (const ref of generated.itemIds) {
			// A term citation: known words reach the model without ids, so "this
			// challenge is about 护照" can only be said with the word itself — and
			// with its reading, when the spelling names two cards.
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

	return { challenges, dropped };
}

// --------------------------------------------------------------------------
// The call
// --------------------------------------------------------------------------

/**
 * How many usable challenges one chunk has to come back with before its reply is
 * accepted without a corrective retry.
 *
 * Half its slots, rounded up. A chunk is short enough that "it dropped one" is
 * ordinary salvage and not worth a second call, while "it answered two of five"
 * means the reply was misunderstood and re-asking is cheap.
 */
function chunkMinimum(slots: number): number {
	return Math.max(1, Math.ceil(slots / 2));
}

/**
 * The rejection a `fetch` on an already-aborted signal would have produced. The
 * signal's own `reason` is preferred when the caller supplied one, so a refill
 * cancelled with a message keeps it.
 */
function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	const error = new Error('The generation was cancelled.');
	error.name = 'AbortError';
	return error;
}

/** What one chunk came back with; `error` is set only when it failed outright. */
interface ChunkOutcome {
	challenges: Challenge[];
	usage: TokenUsage;
	/** Set when the chunk produced nothing usable even after its retry. */
	error?: LlmError;
	/** Set when the failure is not the chunk's fault and must sink the lesson. */
	fatal?: LlmError | Error;
	retried: boolean;
}

/**
 * Runs `worker` over `chunks` with at most `limit` in flight, returning results
 * in **chunk order** whatever order they finish in.
 *
 * A plain `Promise.all` would fire every chunk at once, which for a twelve-word
 * lesson is eight simultaneous completions on a key that may well be rate
 * limited. This is the smallest thing that isn't that: `limit` workers pulling
 * from a shared cursor.
 */
async function runPooled<T, R>(
	chunks: readonly T[],
	limit: number,
	worker: (chunk: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(chunks.length);
	let cursor = 0;

	const run = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= chunks.length) return;
			results[index] = await worker(chunks[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, chunks.length) }, run));
	return results;
}

/**
 * Generates one lesson.
 *
 * The plan is made locally ({@link planSlots}), cut into short requests
 * ({@link chunkSlots}) and run concurrently. Each reply is parsed leniently
 * (fences stripped, bad entries dropped) and gets one corrective retry if too
 * little of it survives.
 *
 * **A chunk that fails is dropped, not fatal.** Four fifths of a lesson is a
 * lesson; it is the merged total that has to clear {@link MIN_BATCH_CHALLENGES},
 * and only then does this throw `LlmError('bad-response')` — with a message that
 * says how many requests failed and how much survived, because "the model
 * returned something unusable" is not a thing anyone can act on. Failures that
 * are not the chunk's fault — a bad key, a rate limit, an abort — sink the whole
 * lesson immediately, since every other chunk would only hit the same wall.
 *
 * It returns challenges and nothing else: the caller pools them, and no part of
 * the learner's vocabulary is touched by generating a lesson.
 */
export async function generateBatch(
	args: BatchArgs,
	opts: BatchOptions = {}
): Promise<BatchResult> {
	const progress = opts.onProgress;
	const model = opts.model?.trim() || getModel();

	const slots = planSlots(args, opts.rng);
	const chunks = chunkSlots(slots, args.reviewItems);
	progress?.({
		id: 'build-prompt',
		label: chunks.length > 1 ? `Planning ${slots.length} challenges` : 'Building the prompt'
	});

	// A two-challenge lesson can never reach five; do not demand the impossible.
	const minimum = Math.max(1, Math.min(MIN_BATCH_CHALLENGES, slots.length));
	const knownItemIds = args.reviewItems.map((i) => i.id);
	const termToId = knownTermIndex(args);

	// Built once, not per chunk or per attempt: it is a pure function of a static
	// registry, and every retry sends the very same schema back.
	const responseFormat = { name: BATCH_SCHEMA_NAME, schema: batchJsonSchema() };

	// Fired at most once each, however many chunks retry — see ProgressStepId.
	let retryAnnounced = false;
	const announceRetry = (): void => {
		if (retryAnnounced) return;
		retryAnnounced = true;
		progress?.({ id: 'retry', label: 'Retrying part of the lesson' });
	};

	progress?.({
		id: 'request',
		label:
			chunks.length > 1
				? `Waiting for ${model} (${chunks.length} requests)`
				: `Waiting for ${model}`
	});

	const outcomes = await runPooled(chunks, CHUNK_CONCURRENCY, async (chunk) => {
		const outcome: ChunkOutcome = {
			challenges: [],
			usage: { promptTokens: 0, completionTokens: 0 },
			retried: false
		};
		const messages = buildChunkPrompt(args, chunk);
		const wanted = chunkMinimum(chunk.slots.length);

		for (let attempt = 0; attempt < 2; attempt++) {
			// An abort between chunks: stop dispatching rather than spending a call
			// nobody is waiting for, and report it the way an in-flight `fetch` on
			// the same signal would, so a cancelled refill never looks like a model
			// that returned nothing usable.
			if (opts.signal?.aborted) {
				outcome.fatal = abortError(opts.signal);
				return outcome;
			}

			const attemptMessages: ChatMessage[] =
				attempt === 0 ? messages : [...messages, { role: 'user', content: CORRECTIVE_INSTRUCTION }];
			if (attempt > 0) {
				outcome.retried = true;
				announceRetry();
			}

			let completion;
			try {
				completion = await chatCompletion({
					messages: attemptMessages,
					model: opts.model,
					apiKey: opts.apiKey,
					signal: opts.signal,
					fetchFn: opts.fetchFn,
					responseFormat,
					temperature: 0.7
				});
			} catch (error) {
				// `bad-response` is this chunk's problem and costs this chunk only;
				// anything else (auth, rate limit, network, abort) would meet every
				// other chunk too, so it ends the lesson.
				if (error instanceof LlmError && error.kind === 'bad-response') {
					outcome.error = error;
					continue;
				}
				outcome.fatal = error instanceof Error ? error : new Error(String(error));
				return outcome;
			}

			outcome.usage.promptTokens += completion.usage.promptTokens;
			outcome.usage.completionTokens += completion.usage.completionTokens;

			let resolved: ResolvedBatch;
			try {
				resolved = resolveBatch(parseBatch(completion.content), {
					newId: opts.newId,
					knownItemIds,
					termToId,
					rng: opts.rng
				});
			} catch (error) {
				if (error instanceof LlmError && error.kind === 'bad-response') {
					outcome.error = error;
					continue;
				}
				outcome.fatal = error instanceof Error ? error : new Error(String(error));
				return outcome;
			}

			if (resolved.challenges.length >= wanted) {
				outcome.challenges = resolved.challenges;
				outcome.error = undefined;
				return outcome;
			}
			// Keep the best partial reply: if the retry also comes back thin, these
			// are still real challenges the learner paid for.
			if (resolved.challenges.length > outcome.challenges.length) {
				outcome.challenges = resolved.challenges;
			}
			outcome.error = new LlmError(
				'bad-response',
				`One request produced ${resolved.challenges.length} of ${chunk.slots.length} challenges.`
			);
		}
		return outcome;
	});

	progress?.({ id: 'validate', label: 'Validating challenges' });

	const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
	const challenges: Challenge[] = [];
	let failed = 0;
	let lastError: LlmError | undefined;

	for (const outcome of outcomes) {
		usage.promptTokens += outcome.usage.promptTokens;
		usage.completionTokens += outcome.usage.completionTokens;
		if (outcome.fatal) throw outcome.fatal;
		if (outcome.error) {
			failed++;
			lastError = outcome.error;
		}
		challenges.push(...outcome.challenges);
	}

	// Chunk order, then slot order within a chunk — the lesson as it was planned,
	// not as the network happened to answer it.
	const merged = challenges.slice(0, MAX_BATCH_CHALLENGES);
	if (merged.length >= minimum) return { challenges: merged, usage };

	throw new LlmError(
		'bad-response',
		`Only ${merged.length} usable challenge(s) came back` +
			(chunks.length > 1 ? ` — ${failed} of ${chunks.length} requests failed` : '') +
			'. Try again.' +
			(lastError ? ` (${lastError.message})` : '')
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
