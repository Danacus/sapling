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
 * {@link makeMatchPairsChallenge}, which reads the same 1-5 ladder the paid
 * types are sized by and spends nothing to do it.
 *
 * **A lesson is many short requests, and each one is about exactly one type.**
 * Asking for twenty challenges about twelve words in a single completion
 * produced visibly worse output towards the end: the model loses track of the
 * rules and of what it has already written, one bad reply costs the whole lesson
 * a corrective retry, and the wall clock is one long serial completion. Asking
 * for a *mixed* handful was better but still a puzzle — every request carried all
 * seven types' field lists and rules, plus a list of slots to match them up
 * against, plus an abstract difficulty number to interpret.
 *
 * So this layer **plans nothing**. It is handed a list of wants — one word, one
 * kind, one rung each, decided by the session against what its pool already
 * holds (`$lib/session/topup`) — {@link groupIntoRequests} cuts that list by
 * **kind**, and {@link generateBatch} runs the requests concurrently. One
 * request is one wire type: its system prompt ({@link systemPromptFor})
 * explains that type and no other, its JSON schema admits that type and no
 * other, and its payload is a list of words each carrying the **countable
 * parameters** that type is sized by — a sentence length, a word-bank size, a
 * tile count, computed here from the want's rung by the def's own `params`. The
 * model never sees the word "want", a difficulty from 1 to 5, or the six types
 * it is not writing. The prompt stays static *per type*, which is what keeps
 * prompt caching paying across a top-up's requests and across sessions.
 *
 * Each request carries its own corrective retry, and a request that still fails
 * is **dropped, not fatal**: the result is whatever came back, reported with
 * how many requests failed, and only *nothing* coming back is an error.
 *
 * Everything here is stateless with respect to the database: data in, data out.
 * The caller persists the result.
 *
 * What it deliberately does *not* know is the challenge types. Each wire type
 * owns its schema, its prompt line, its parameter ladder, its corrective line
 * and its resolver in `./challenge-types/<type>.ts`; this module wraps whichever
 * def a request is for in a shared preamble and dispatches to it, and even
 * `generatedChallengeSchema` — imported below from `./schemas` — is a projection
 * of that same registry. The pipeline it keeps for itself is the part that is
 * the same for every type: the calls and their corrective retries,
 * salvage-parsing, id minting, term-citation resolution, and counting what had
 * to be dropped.
 */

import { getModel } from '$lib/db/settings';
import { termKey } from '$lib/text';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import { byType } from './challenge-types';
import type {
	AnyWireTypeDef,
	ChallengeBase,
	ChallengeParams,
	DifficultyRung,
	ResolveContext
} from './challenge-types';
import { chatCompletion, LlmError } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';
import { labelKey, optionalString, shuffled, undefinedIfBlank } from './resolve-helpers';
import {
	batchJsonSchemaFor,
	batchSchemaNameFor,
	generatedChallengeSchema,
	looseBatchSchema
} from './schemas';
import type { GeneratedChallenge } from './schemas';
import { REQUEST_CONCURRENCY, groupIntoRequests, kindKey, kindOf } from './requests';
import type { TypeRequest, Want } from './requests';

/**
 * Re-exported for callers (and tests) that knew them as part of this module
 * before the per-type defs moved out to `./challenge-types`. Their home is
 * `./resolve-helpers`.
 */
export { MAX_WORD_ORDER_DISTRACTORS, MAX_WORD_ORDER_TILES } from './resolve-helpers';

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
 * step from its event to the next, so a step per request would turn a truthful
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
	 * The challenges to write: one word, one kind, one rung each. This is the
	 * whole brief — the session decides it against what its pool already holds
	 * (`$lib/session/topup`), and this layer only fills it. Every challenge that
	 * comes back exercises one of these words; a batch has no other source of
	 * vocabulary. No accuracy or recent-mistake dial rides along: FSRS already
	 * lowers a missed word's strength, so its rung falls on its own.
	 */
	wants: Want[];
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
	/**
	 * Requests that contributed nothing even after their retry. Their wants are
	 * simply still wanting: the next top-up asks for them again, so this is
	 * information for the learner, not an error — unless it is *every* request,
	 * which {@link generateBatch} throws on instead.
	 */
	failedRequests: number;
}

// --------------------------------------------------------------------------
// Prompt
// --------------------------------------------------------------------------

/**
 * True when this wire type has an `instruction` field, read off its own schema.
 *
 * The heading rule is worth a line only where there is a field to write it into,
 * and a def that grows one should get the rule without anyone remembering to add
 * it here. The cast is the price: `WireTypeDef.schema` is declared as the
 * general `z.ZodType`, which has no `shape` — every def's is in fact a
 * `z.ZodObject`, and asking for a key it may not have is the narrowest possible
 * way to depend on that.
 */
function hasInstructionField(def: AnyWireTypeDef): boolean {
	const shape = (def.schema as { shape?: Record<string, unknown> }).shape;
	return !!shape && 'instruction' in shape;
}

/**
 * The system prompt for **one wire type**. Written for tokens, not for looks: no
 * pleasantries, one inline example, rules as bare imperatives.
 *
 * Static per type and memoised, which is what keeps prompt caching paying: a
 * lesson's requests of the same kind quote a byte-identical prefix, and so does
 * every lesson after this one. Splitting the prompt per type made it *cheaper*
 * rather than dearer — a request used to carry all seven types' field lists,
 * examples and rules to ask for four challenges of one of them.
 *
 * What it says is only ever about this one type. The shared preamble names no
 * type at all, then `promptSpec` gives this type's fields and example,
 * `paramsSpec` explains the counts each item carries, and `rulesSpec` adds
 * whatever else this type needs — including rules a second type also needs
 * (segmentation is spelled out in both tile types), because a duplicated line is
 * only ever paid on its own type's calls.
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
 *   name the bland patterns explicitly so they can be refused. The
 *   no-repeated-frame rule matters more here than it did: a reply is now six
 *   challenges of the *same* type, which is exactly where a model starts
 *   producing variations on one sentence.
 *
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
 * There is no difficulty ladder here at all any more, and no "difficulty" key
 * for the model to interpret. Difficulty *is* the parameters on each item — a
 * word count, a bank size, a tile count — which each def computes from the
 * planned rung and explains in its own `paramsSpec`. A number the model can
 * count is a number it can hit.
 */
function composeSystemPrompt(def: AnyWireTypeDef): string {
	return (
		[
			'You are an expert language-course author. Output one JSON object and nothing else: no prose, no markdown fences.',
			'Shape: {"challenges":[Challenge]}',
			`Every Challenge has: type (always "${def.type}"), itemIds, explanation (one short sentence or null), plus the fields below.`,
			'TargetText, written {"text":..,"reading":..}, is one string of the TARGET language plus its Latin reading: pinyin with tone marks for Mandarin, romaji for Japanese, revised romanization for Korean, the standard scheme otherwise. "reading" is ALWAYS null when the target language is written in the Latin script. Every field that is not a TargetText is plain text in the NATIVE language.',
			'Type:',
			def.promptSpec,
			'Each entry in items also carries the size to write it at:',
			def.paramsSpec,
			'Rules:',
			`- items is the exact lesson to write: exactly one "${def.type}" challenge per entry, in the same order, about the word that entry names, at the size that entry gives. Never another type, never an extra challenge, never an entry left unwritten.`,
			'- Treat every size as a target to hit, not a maximum: one or two either side is fine, half or double is not.',
			'- itemIds: the id of an item, or — for a challenge built on a word from known — that word exactly as it appears in known, its parenthesised reading included. Never invent anything else.',
			'- A known entry written "word (reading)" is one of two same-spelled words told apart by how it is read; cite it with the parenthesis, but write only the word itself into a sentence.',
			'- Sides never swap: a field described as native-language text is always in the NATIVE language and never contains target-language words or script, and every TargetText is always the target language. A challenge whose question and answers are in the same language is invalid.',
			'- Wrong options must be plausible: same part of speech and register, never a synonym of the right answer, never obviously absurd — and never a second right answer. If two would both fit, rewrite the question.',
			'- Answerable from what is shown alone: the prompt, plus the challenge type, must uniquely determine the answer. Never an open question whose answer depends on facts you never state — directions, prices, names, times, opinions, anything from an imagined scene the learner cannot see.',
			'- In a situational dialogue either give the exact line to produce ("Say: \'the fish stall is to the right\'") or make answers cover every plausible alternative reply.',
			hasInstructionField(def)
				? '- instruction: a short heading, in the NATIVE language, matched to what the challenge actually asks — "What does this mean?" for a plain meaning question, "Pick the best reply" or "How would you answer?" for a conversational turn; null when the default meaning-question heading fits.'
				: undefined,
			"- known is the learner's whole vocabulary and it is what you build with: every challenge is about one of the items, and the words around it come from known, so the learner mostly reads what they can already read. Teach nothing new — a word outside known may appear as glue when a sentence needs it, never as the thing being tested.",
			def.rulesSpec,
			'Voice:',
			'- Conversation, not flashcards: every prompt, sentence and translation is a line someone would really say — a dialogue turn, a question put to the learner, a request, a reaction, an opinion. Never an isolated textbook statement.',
			'- With a "topic", EVERY challenge happens inside that scenario: sentences are turns of that dialogue, translations are things you would really say there, and the words in items are worked into it. "interests" then only colour word choice, never the sentence frame.',
			'- "about" is the learner in their own words. Set scenarios in their life — their city, work, people, tastes — and let it colour word choice and examples. Never recite it back to them, never contradict it, and "topic" still outranks it.',
			'- Banned: "I like <interest>", "<interest> is fun", any sentence whose only content is that the learner likes their interest, and reusing a sentence frame twice in one reply. Vary speaker, question vs statement, and register for the level.',
			'- explanation: one line of usage or culture (register, politeness, word order) when non-obvious, written in the NATIVE language (target-language words may be quoted inside it); null when it would only restate the answer.'
		]
			// `rulesSpec` is optional, and the instruction rule is conditional — a line
			// that does not apply is absent rather than blank.
			.filter((line): line is string => line !== undefined)
			.join('\n')
	);
}

/** Composed once per type and kept: see {@link composeSystemPrompt}. */
const systemPrompts = new Map<string, string>();

/** This type's system prompt — the same string for every request of this kind. */
export function systemPromptFor(def: AnyWireTypeDef): string {
	const cached = systemPrompts.get(def.type);
	if (cached !== undefined) return cached;
	const prompt = composeSystemPrompt(def);
	systemPrompts.set(def.type, prompt);
	return prompt;
}

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
 * Builds the two messages for **one request**. The user message is compact JSON
 * — no field labels in prose, no restating of the rules.
 *
 * The system half is this type's own static string, so a top-up's requests of
 * one kind share a cached prefix and every top-up after this one shares it too.
 * The user half is genuinely short. `type` does not travel — it is the whole
 * subject of the system prompt. Neither does `difficulty`: each item carries the
 * *parameters* that rung means for this type instead, which is a number the
 * model can count rather than a scale it has to interpret. Nothing about how
 * the learner has been doing travels either: a missed word's strength has
 * already fallen, so its rung — and so its sizes — fell with it.
 *
 * `known` is *not* narrowed to the request's words. It is the vocabulary every
 * sentence is built out of, whichever words are being tested, and it is the
 * citation vocabulary the resolver indexes — so it rides along whole, in the
 * same order, on every request. That repetition is the price of the split;
 * against the static prompt it is the smaller half.
 *
 * **Key order is load-bearing.** Everything identical across a top-up's requests
 * — profile, `topic`, `about` and the whole `known` list, which is by far the
 * largest block — is written first, and only `items` last. A prefix cache pays
 * up to the first byte that differs, so putting `known` after the items would
 * throw away the cache on exactly the block worth caching.
 */
export function buildRequestPrompt(args: BatchArgs, request: TypeRequest): ChatMessage[] {
	const { profile } = args;
	const def = defFor(request);

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
		// Terms only — the ids stay local (see `knownItems` and `knownTermIndex`).
		// Last of the shared block and first of the big ones: everything above it
		// is byte-identical across a lesson's requests, and a prefix cache pays
		// only up to the first byte that differs, so `items` comes after.
		...(args.knownItems?.length ? { known: knownTermLabels(args.knownItems) } : {}),
		// The brief: one entry per challenge to write. The term and meaning ride
		// beside the id so the entry reads without a lookup, and this type's own
		// parameters — however many keys that is — spread in beside them.
		items: request.wants.map((want) => ({
			id: want.item.id,
			t: want.item.term,
			...(want.item.meaning ? { m: want.item.meaning } : {}),
			...def.params(want.difficulty, request.kind)
		}))
	};

	return [
		{ role: 'system', content: systemPromptFor(def) },
		{ role: 'user', content: JSON.stringify(payload) }
	];
}

/**
 * Appended verbatim when a first attempt came back mostly unusable.
 *
 * A second, much terser pass at the same field list: by the time this is sent
 * the model has already ignored the schema once, so it restates only the
 * *required* fields of the one type this request is about — no examples, no
 * optional keys, and nothing about the six types it was never asked for.
 */
export function correctiveInstructionFor(def: AnyWireTypeDef): string {
	return (
		'Your previous reply was rejected. Return ONLY a raw JSON object {"challenges":[...]}, no fences, no commentary. Every challenge needs type, itemIds and its own fields: ' +
		def.correctiveSpec +
		'. Every target-language slot is a TargetText object {"text","reading"}, reading null for Latin scripts. Keep to the sizes each item asked for.'
	);
}

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
 * The least a schema must be to validate one entry — every def's `schema` and
 * the whole `generatedChallengeSchema` union both satisfy it. Structural rather
 * than `z.ZodType<GeneratedChallenge>` because a def's schema is typed to its
 * own narrow payload, and zod's parameterised type is not assignable up to the
 * union it belongs to.
 */
export interface ChallengeMemberSchema {
	safeParse(value: unknown): { success: boolean; data?: GeneratedChallenge };
}

/**
 * Parses a completion into validated entries, salvaging what it can: a single
 * malformed challenge costs us that challenge, not the batch we already paid
 * for. Throws `LlmError('bad-response')` only when the envelope itself is
 * unusable.
 *
 * `member` is the schema each entry is validated against. A request asks for one
 * wire type, so it passes that type's own schema and a challenge of any other
 * type is simply not an entry — the union default is for the mock, which emits
 * every type at once on purpose.
 */
export function parseBatch(
	raw: string,
	member: ChallengeMemberSchema = generatedChallengeSchema
): ParsedBatch {
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
		const parsed = member.safeParse(entry);
		if (parsed.success && parsed.data) challenges.push(parsed.data);
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
	// The wanted words first: they are the subject of this batch, so an ambiguous
	// bare citation is likelier to be about one of them than about the rest of
	// the collection.
	for (const want of args.wants) {
		const key = termKey(want.item.term);
		if (!index.has(key)) index.set(key, want.item.id);
	}

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
	/**
	 * The parameters each word's challenge was asked for, by item id — what the
	 * resolver holds the model to where it can (a cloze's bank size, a
	 * word-order's distractor count; see {@link ResolveContext.params}).
	 *
	 * Keyed by item because that is the only handle available at resolve time: a
	 * challenge has not been matched to its planned entry yet, and cannot be
	 * until it *is* a challenge. Within one request a word appears exactly once,
	 * so the first of a challenge's resolved ids that this map knows is
	 * unambiguously the entry it answers. Omitted by the mock and by tests, and
	 * then every resolver behaves exactly as it did before.
	 */
	paramsByItem?: ReadonlyMap<string, ChallengeParams>;
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

		// The entry this challenge answers, as far as its citations reveal it.
		const params = options.paramsByItem
			? unique
					.map((itemId) => options.paramsByItem?.get(itemId))
					.find((found) => found !== undefined)
			: undefined;

		const resolved = resolveOne(generated, { base, rng, ...(params ? { params } : {}) });
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
 * How many of its items one request has to fill before its reply is accepted
 * without a corrective retry.
 *
 * Half of them, rounded up. A request is short enough that "it dropped one" is
 * ordinary salvage and not worth a second call, while "it filled two of six"
 * means the brief was misunderstood and re-asking is cheap.
 */
function requestMinimum(items: number): number {
	return Math.max(1, Math.ceil(items / 2));
}

/**
 * The def a request is for.
 *
 * Total by construction — a `SlotKind` names a registered wire type, and
 * `_registryParity` in `./challenge-types` fails `pnpm check` if the registry
 * and the union ever disagree — so the throw is an assertion, not a path.
 */
function defFor(request: TypeRequest): AnyWireTypeDef {
	const def = byType.get(request.kind.type);
	if (!def) throw new Error(`No wire type def for ${request.kind.type}.`);
	return def;
}

/**
 * The challenges from one reply that fill this request's brief, in the order
 * the brief listed its words.
 *
 * A request asks for an exact list — six challenges of one kind, one per word —
 * and a reply that comes back the right *length* has told us nothing about
 * whether it is what was asked for. The model does substitute: six banked
 * clozes come back as six multiple-choice questions, or one word gets all six
 * challenges. Counting cannot see either. So each resolved challenge is read
 * back as the kind it *is* ({@link kindOf}: the stored `{type, direction}` its
 * wire def declares, plus whether a word bank actually survived resolution — a
 * banked cloze whose distractors all duplicated the answer is not the exercise
 * that was asked for, and the retry is the cheaper fix) and has to be about the
 * word the entry named.
 *
 * Each entry is filled at most once, so a request can never return more than it
 * was asked for. Anything that matches no unfilled entry is dropped rather than
 * kept as a bonus: it is a challenge about the wrong word or in the wrong
 * format, the corrective retry re-asks for the real one, and a pool padded with
 * the questions the model felt like writing is the thing this whole design
 * exists to stop.
 */
function fillRequest(challenges: readonly Challenge[], request: TypeRequest): Challenge[] {
	const wanted = kindKey(request.kind);
	const filled = new Array<Challenge | undefined>(request.wants.length).fill(undefined);
	for (const challenge of challenges) {
		const kind = kindOf(challenge);
		if (!kind || kindKey(kind) !== wanted) continue;
		const at = request.wants.findIndex(
			(want, i) => filled[i] === undefined && challenge.itemIds.includes(want.item.id)
		);
		if (at >= 0) filled[at] = challenge;
	}
	return filled.filter((challenge): challenge is Challenge => challenge !== undefined);
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

/** Cancels the requests still in flight once one of them has sunk the lesson. */
function siblingAbort(): Error {
	const error = new Error('Another request ended the lesson.');
	error.name = 'AbortError';
	return error;
}

/** What one request came back with; `error` is set only when it failed outright. */
interface RequestOutcome {
	filled: Challenge[];
	usage: TokenUsage;
	/** Set when the request produced nothing usable even after its retry. */
	error?: LlmError;
	retried: boolean;
}

/**
 * Runs `worker` over `jobs` with at most `limit` in flight, returning results in
 * **job order** whatever order they finish in.
 *
 * A plain `Promise.all` would fire every request at once, which for a twelve-word
 * lesson is several simultaneous completions on a key that may well be rate
 * limited. This is the smallest thing that isn't that: `limit` workers pulling
 * from a shared cursor.
 *
 * There is deliberately no cancellation here: a worker that decides the run is
 * over returns its own (empty) result, so the pool always resolves and the
 * caller's accounting sees every job. See `generateBatch`'s `stop` controller.
 */
async function runPooled<T, R>(
	jobs: readonly T[],
	limit: number,
	worker: (job: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(jobs.length);
	let cursor = 0;

	const run = async (): Promise<void> => {
		for (;;) {
			const index = cursor++;
			if (index >= jobs.length) return;
			results[index] = await worker(jobs[index], index);
		}
	};

	await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, run));
	return results;
}

/**
 * Fills a list of wants.
 *
 * The wants are cut by kind into single-type requests
 * ({@link groupIntoRequests}) and run concurrently. Each reply is parsed
 * leniently (fences stripped, bad entries dropped) and gets one corrective
 * retry if too little of it survives.
 *
 * **A request that fails is dropped, not fatal.** Its wants are simply still
 * wanting, and the next top-up asks for them again; the result says how many
 * requests failed (`failedRequests`) so the learner can be told, and only when
 * *nothing* came back does this throw `LlmError('bad-response')` — with a
 * message that says how many requests failed, because "the model returned
 * something unusable" is not a thing anyone can act on. Failures that are not
 * one request's fault — a bad key, a rate limit, an abort — sink the whole
 * top-up **immediately and literally**: the first one cancels the requests
 * still in flight and every one still queued returns without spending a call,
 * since they would all only hit the same wall.
 *
 * Each reply is checked against the entries it was asked for, not merely
 * counted ({@link fillRequest}) — a request is worth what it filled — and the
 * survivors come back in **request order**, requests in first-appearance order
 * and challenges in brief order within each, whatever order the network
 * answered. The pool the caller writes them into has no order of its own to
 * preserve; the session plans what to play out of the whole of it.
 *
 * It returns challenges and nothing else: the caller pools them, and no part of
 * the learner's vocabulary is touched by generating.
 */
export async function generateBatch(
	args: BatchArgs,
	opts: BatchOptions = {}
): Promise<BatchResult> {
	const model = opts.model?.trim() || getModel();

	// A progress callback is the caller's UI; a throw inside one must not take
	// the lesson with it — and inside the pool it would surface as an unhandled
	// rejection in a sibling worker rather than as anything anyone could debug.
	const report = (step: ProgressStep): void => {
		if (!opts.onProgress) return;
		try {
			opts.onProgress(step);
		} catch {
			/* The step log is a nicety; losing it never costs the lesson. */
		}
	};

	// Nothing to write. Announcing a `request` step and then reporting an
	// unusable reply would blame the model for a call that was never made, so
	// this says what actually happened, before any step is announced.
	const requests = groupIntoRequests(args.wants);
	if (requests.length === 0) {
		throw new LlmError('bad-response', 'There is nothing to write: no challenges were asked for.');
	}
	const total = requests.reduce((n, request) => n + request.wants.length, 0);
	report({
		id: 'build-prompt',
		label: requests.length > 1 ? `Preparing ${total} challenges` : 'Building the prompt'
	});

	const knownItemIds = [...new Set(args.wants.map((want) => want.item.id))];
	const termToId = knownTermIndex(args);

	// Fired at most once each, however many requests retry — see ProgressStepId.
	let retryAnnounced = false;
	const announceRetry = (): void => {
		if (retryAnnounced) return;
		retryAnnounced = true;
		report({ id: 'retry', label: 'Retrying part of the lesson' });
	};

	// The lesson's own stop switch. A failure that is not one request's fault
	// would meet every request, so the first one to see it records the error here
	// and aborts `stop`: the siblings already in flight unwind at their `fetch`,
	// and every request the pool has not dispatched yet returns without a call.
	// The caller's own signal is chained into it, reason and all, so a cancelled
	// refill still fails as the cancellation it was.
	let fatal: LlmError | Error | undefined;
	const stop = new AbortController();
	const sink = (error: LlmError | Error): void => {
		fatal ??= error;
		if (!stop.signal.aborted) stop.abort(siblingAbort());
	};
	const onCallerAbort = (): void => {
		if (!stop.signal.aborted) stop.abort(opts.signal?.reason);
	};
	opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

	report({
		id: 'request',
		label:
			requests.length > 1
				? `Waiting for ${model} (${requests.length} requests)`
				: `Waiting for ${model}`
	});

	const outcomes = await runPooled(requests, REQUEST_CONCURRENCY, async (request) => {
		const outcome: RequestOutcome = {
			filled: [],
			usage: { promptTokens: 0, completionTokens: 0 },
			retried: false
		};
		const def = defFor(request);
		const messages = buildRequestPrompt(args, request);
		const wanted = requestMinimum(request.wants.length);
		// One type per request means one schema per request — the model cannot
		// return a shape this brief did not ask for. Built once per request, since
		// a retry sends the very same schema back.
		const responseFormat = {
			name: batchSchemaNameFor(def),
			schema: batchJsonSchemaFor(def)
		};
		// A word appears at most once in a request, so its parameters are the ones
		// any challenge citing it was asked for. See `ResolveOptions.paramsByItem`.
		const paramsByItem = new Map(
			request.wants.map(
				(want) => [want.item.id, def.params(want.difficulty, request.kind)] as const
			)
		);

		for (let attempt = 0; attempt < 2; attempt++) {
			// An abort between requests: stop dispatching rather than spending a call
			// nobody is waiting for, and report it the way an in-flight `fetch` on
			// the same signal would, so a cancelled refill never looks like a model
			// that returned nothing usable.
			if (opts.signal?.aborted) {
				sink(abortError(opts.signal));
				return outcome;
			}
			// A sibling has already sunk the lesson; this one is not worth a call.
			if (stop.signal.aborted) return outcome;

			const attemptMessages: ChatMessage[] =
				attempt === 0
					? messages
					: [...messages, { role: 'user', content: correctiveInstructionFor(def) }];
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
					// `stop`, not `opts.signal`: it carries the caller's cancellation
					// *and* a sibling's fatal failure, so neither leaves a call running.
					signal: stop.signal,
					fetchFn: opts.fetchFn,
					responseFormat,
					temperature: 0.7
				});
			} catch (error) {
				// `bad-response` is this request's problem and costs this request only;
				// anything else (auth, rate limit, network, abort) would meet every
				// other request too, so it ends the lesson — for all of them at once.
				if (error instanceof LlmError && error.kind === 'bad-response') {
					outcome.error = error;
					continue;
				}
				sink(error instanceof Error ? error : new Error(String(error)));
				return outcome;
			}

			outcome.usage.promptTokens += completion.usage.promptTokens;
			outcome.usage.completionTokens += completion.usage.completionTokens;

			let resolved: ResolvedBatch;
			try {
				// Validated against this request's own member schema: a challenge of
				// another type is not a challenge this reply was allowed to contain.
				resolved = resolveBatch(parseBatch(completion.content, def.schema), {
					newId: opts.newId,
					knownItemIds,
					termToId,
					rng: opts.rng,
					paramsByItem
				});
			} catch (error) {
				if (error instanceof LlmError && error.kind === 'bad-response') {
					outcome.error = error;
					continue;
				}
				sink(error instanceof Error ? error : new Error(String(error)));
				return outcome;
			}

			// What the request is worth is what it *filled*, not what it returned.
			const filled = fillRequest(resolved.challenges, request);
			if (filled.length >= wanted) {
				outcome.filled = filled;
				outcome.error = undefined;
				return outcome;
			}
			// Keep the best partial reply: if the retry also comes back thin, these
			// are still real challenges the learner paid for.
			if (filled.length > outcome.filled.length) {
				outcome.filled = filled;
			}
			outcome.error = new LlmError(
				'bad-response',
				`One request filled ${filled.length} of its ${request.wants.length} ${def.type} challenges.`
			);
		}
		return outcome;
	}).finally(() => opts.signal?.removeEventListener('abort', onCallerAbort));

	// Ahead of the `validate` step, and of any accounting: nothing was validated,
	// and a bad key is not a lesson that came back thin.
	if (fatal) throw fatal;

	report({ id: 'validate', label: 'Validating challenges' });

	const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
	const challenges: Challenge[] = [];
	let failedRequests = 0;
	let lastError: LlmError | undefined;

	// Request order — `runPooled` hands the outcomes back in job order whatever
	// order they settled in — and brief order within each request.
	for (const outcome of outcomes) {
		usage.promptTokens += outcome.usage.promptTokens;
		usage.completionTokens += outcome.usage.completionTokens;
		if (outcome.error) {
			// A request whose best partial reply was kept is not a failed request:
			// its challenges are in the result. Only one that contributed nothing.
			if (outcome.filled.length === 0) failedRequests++;
			lastError = outcome.error;
		}
		challenges.push(...outcome.filled);
	}

	if (challenges.length > 0) return { challenges, usage, failedRequests };

	throw new LlmError(
		'bad-response',
		'Nothing usable came back' +
			(requests.length > 1 ? ` — all ${requests.length} requests failed` : '') +
			'. Try again.' +
			(lastError ? ` (${lastError.message})` : '')
	);
}

// --------------------------------------------------------------------------
// Zero-token local generation
// --------------------------------------------------------------------------

/**
 * Smallest and largest pair count for an *unsized* round — one built without a
 * ladder rung, which is what every caller that has no vocabulary strength to
 * read gets. Kept exactly where it has always been, so nothing that never asked
 * for a difficulty sees a different round than it did before.
 */
const MATCH_MIN = 4;
const MATCH_MAX = 5;

/**
 * Pairs per round at each rung of the ladder — the free round's answer to the
 * `params` ladders every paid type now has. A new word's round is three pairs
 * because the point of it is a breather; a word the learner owns gets six,
 * which is about as tall a column as a phone screen holds — the learn route's
 * stage grows rather than clips, so a taller round only costs a scroll, but six
 * is where the round stops being one glance.
 *
 * Bounded by the stored side's own scale on purpose: `$lib/challenges/types/match-pairs`
 * measures a round's difficulty over `FEWEST_PAIRS` (2) to `MOST_PAIRS` (6), so
 * a ladder reaching past six would peg every top rung at the same stored
 * difficulty and the planner's fit preference would stop being able to tell them
 * apart.
 */
const MATCH_PAIRS_LADDER = [3, 4, 5, 6, 6] as const;

/** The fewest pairs any rung asks for — the floor a sized round declines below. */
const LADDER_MIN = Math.min(...MATCH_PAIRS_LADDER);

export interface MatchPairsOptions {
	/**
	 * The ladder rung to size the round for. Omitted means "unsized": four or
	 * five pairs, drawn from `rng`, exactly as this function has always behaved.
	 */
	difficulty?: DifficultyRung;
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
 * **Size comes from the same ladder everything else is written to.** Given a
 * rung, the round asks for {@link MATCH_PAIRS_LADDER} pairs — the zero-cost
 * type's version of a def's `params`, so the one challenge nobody pays for is no
 * longer the one challenge that ignores how far along the learner is. Given
 * none, it is the four-or-five it always was.
 *
 * Returns `undefined` when fewer collision-free items remain than the smallest
 * round that mode can ask for: four unsized, {@link LADDER_MIN} with a rung.
 * Between that floor and the rung's own count it builds the *smaller* round
 * rather than declining — a slightly short round is still a breather, and the
 * alternative is no round at all for a learner with a dozen words.
 *
 * @param rng Injectable `[0,1)` source so tests (and replays) are deterministic.
 */
export function makeMatchPairsChallenge(
	items: KnowledgeItem[],
	rng: () => number = Math.random,
	options: MatchPairsOptions = {}
): Challenge | undefined {
	const rung = options.difficulty;
	const smallest = rung === undefined ? MATCH_MIN : LADDER_MIN;

	const usable = items.filter((i) => i.term?.trim() && i.meaning?.trim());
	if (usable.length < smallest) return undefined;

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
	if (distinct.length < smallest) return undefined;

	// Sized: the rung names the count outright and no draw is spent on it, so a
	// round is a pure function of the rung once the shuffle has happened.
	// Unsized: the old four-or-five draw, untouched.
	let wanted: number;
	if (rung === undefined) {
		const max = Math.min(MATCH_MAX, distinct.length);
		wanted = max > MATCH_MIN ? MATCH_MIN + Math.floor(rng() * (max - MATCH_MIN + 1)) : MATCH_MIN;
	} else {
		wanted = MATCH_PAIRS_LADDER[rung - 1];
	}
	const chosen = distinct.slice(0, Math.min(wanted, distinct.length));

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
