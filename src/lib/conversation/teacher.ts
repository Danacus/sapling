/**
 * The turn loop: one learner message in, one teacher turn out.
 *
 * Structurally this is `$lib/assistant/chat`, and deliberately so — the same
 * tool exchange, the same "failures are data" rule, the same atomic turn, the
 * same {@link ToolContext} seam instead of a database. Three things differ, and
 * each of them is the feature:
 *
 * - **The reply is structured.** A turn carries what the teacher says, what it
 *   means, and what the learner got wrong, in three separate fields — because a
 *   correction mixed into the spoken line stops the conversation being a
 *   conversation. `responseFormat` pins the envelope on every request, and
 *   {@link parseTeacherReply} falls back to prose rather than letting a
 *   malformed turn end the session.
 * - **Two rounds, not five.** There is exactly one tool and no read-then-write
 *   pattern, so a second round is for recovering from a failed call and nothing
 *   else.
 * - **History replays as dialogue.** Prior teacher turns go back as plain
 *   `assistant` messages carrying only what was said; learner turns go back as
 *   what the learner actually typed, never the corrected version — correcting
 *   the record would teach the model that the learner writes better than they
 *   do. The envelope never travels in the history: the system prompt restates
 *   the output contract and `responseFormat` pins it every turn.
 *
 * The one tool is `add_words`, reused verbatim from `$lib/assistant/tools`, so
 * a word the teacher hears goes into the list through the same executor the
 * chat assistant and the generation path use — dedupe by term key, a real FSRS
 * card, a sync event.
 */

import type { ActionNote } from '$lib/assistant';
import { addWordsTool, defaultToolContext, executeToolCall } from '$lib/assistant/tools';
import type { ToolContext } from '$lib/assistant/tools';
import { chatCompletion, stripFences } from '$lib/llm';
import { sameRomanization } from './diff';
import { toJsonSchema } from '$lib/llm/json-schema';
import type { ChatMessage, FetchLike, ToolDef } from '$lib/llm';
import type { KnowledgeItem, Level, Profile } from '$lib/types';
import { TEACHER_REPLY_SCHEMA_NAME, teacherReplyJsonSchema, teacherReplySchema } from './schemas';
import type { Correction, Scenario, TargetLine, TeacherReply } from './schemas';

/** What the learner wrote, plus the correction that came back with the next turn. */
export interface LearnerTurn {
	role: 'learner';
	/** Exactly what they typed. Never overwritten by `correction.corrected`. */
	text: string;
	correction?: Correction;
}

/** One teacher line as the UI holds it. */
export interface TeacherTurn {
	role: 'teacher';
	reply: TargetLine;
	translation?: string;
	/** Vocabulary the teacher filed away on this turn; usually empty. */
	actions: ActionNote[];
}

/** The transcript, ephemeral by design — nothing here is persisted. */
export type ConversationTurn = LearnerTurn | TeacherTurn;

/**
 * One completed exchange. The correction is returned beside the teacher's turn
 * rather than on it, because it belongs to the learner's *previous* bubble —
 * the caller attaches it there and the bubble updates in place.
 */
export interface TurnResult {
	teacher: TeacherTurn;
	correction?: Correction;
}

/** Test seams and per-call overrides. Production passes none of them. */
export interface TurnOptions {
	signal?: AbortSignal;
	fetchFn?: FetchLike;
	apiKey?: string;
	model?: string;
	/** Overrides part of the {@link ToolContext} — the in-memory store tests use. */
	deps?: Partial<ToolContext>;
}

/**
 * How much of the word list the prompt carries.
 *
 * The block is re-sent on every turn, so it is a running cost, not a one-off:
 * 200 words is a few hundred tokens and covers everything a beginner could
 * plausibly reach for. Past that the newest words are the ones worth spending
 * on, which is why the list is cut from the recent end.
 */
export const MAX_CONTEXT_WORDS = 200;

/** One tool, no read-then-write: a second round exists to recover a failed call. */
export const MAX_TOOL_ROUNDS = 2;

/**
 * Room for a reply, its reading, a translation and a correction that rewrites
 * the learner's whole message.
 *
 * Set well clear of the worst case rather than close to the typical one. It is
 * a ceiling, not a budget — an unused token is not billed — and the only thing
 * a tight limit buys is a turn that stops mid-envelope and loses fields the
 * learner would have read.
 */
export const MAX_REPLY_TOKENS = 2000;

/**
 * Used when the model spent both rounds on tools and never said anything.
 *
 * Language-neutral on purpose: the app has no way to write a line of the target
 * language itself, and faking one would put words in the teacher's mouth. An
 * ellipsis reads as a pause, and the learner simply writes again.
 */
export const ROUND_LIMIT_REPLY = '…';

/**
 * How long a reply may be, per level.
 *
 * Stated as a hard shape rather than "at their level", because a model reads
 * "short sentences, common words" as advice and a sentence count as a rule.
 * Every level ends in a question: the teacher's first job is that the
 * conversation does not die, and a question is what hands the turn back.
 */
const REPLY_LENGTH: Record<Level, string> = {
	beginner: 'one short sentence, then one short question. No more than that.',
	elementary: 'one short sentence, then one short question. No more than that.',
	intermediate: 'one or two short sentences, then one question.',
	advanced: 'two or three sentences, then one question.'
};

/**
 * The learner's vocabulary, newest first, as `term (reading) = meaning` lines.
 *
 * Compact rather than JSON because it is paid for on every single turn, and the
 * model needs to recognize these words, not parse them.
 */
export function buildWordBlock(items: KnowledgeItem[]): string {
	const recent = [...items]
		.sort((a, b) => b.introducedAt - a.introducedAt)
		.slice(0, MAX_CONTEXT_WORDS);

	return recent
		.map((item) =>
			item.romanization
				? `${item.term} (${item.romanization}) = ${item.meaning}`
				: `${item.term} = ${item.meaning}`
		)
		.join('\n');
}

/**
 * The system prompt.
 *
 * The static text comes first and the word block last, so the cacheable prefix
 * stays byte-identical across the turns of a session — the scene is fixed for
 * the session's whole life, and only the list can grow under it.
 *
 * The correction rule is spelled out with its counter-example because "correct
 * only real mistakes" is the instruction a model reliably over-reads: left to
 * itself it will treat asking for the wrong thing, or saying something odd, as
 * an error to be fixed, and the role-play dies on the second turn.
 */
export function buildSystemPrompt(
	profile: Profile,
	scenario: Scenario,
	items: KnowledgeItem[]
): string {
	const { targetLanguage: target, nativeLanguage: native } = profile;

	const rules = [
		`You are role-playing a conversation with a ${profile.level} learner of ${target}, whose native language is ${native}.`,
		`The scene: ${scenario.setting} You are ${scenario.teacherRole}. The learner is ${scenario.learnerRole}. You are only ever ${scenario.teacherRole}: never write the learner's line for them, never continue their turn, never speak as if you were them.`,
		`Speak only ${target}, and keep "reply" to ${REPLY_LENGTH[profile.level]} Ask about one thing at a time. Do not explain, do not list what they did not ask about, do not stack questions. A reply that runs long is a worse reply.`,
		`The learner may have no ${target} keyboard. Writing ${target} in Latin-script romanization is normal input, not a mistake: read it phonetically, be generous about spelling, spacing, tone marks and accents, and answer what they meant. Never correct them for having written in romanization. They may also mix ${target} script and romanization in one message, a word here and a word there; that is not a mistake either.`,
		'If you genuinely cannot tell what they meant, stay in character and ask them to say it another way. Never invent a message they did not send, and never answer a question they did not ask.',
		'Return one JSON object and nothing else, no markdown fences: {"reply":{"text","reading"},"translation","correction"}.',
		`"reply" is your line in ${target}. "reading" is its Latin-script reading when ${target} is not written in the Latin script, and null when it is.`,
		`"translation" is that same line in ${native}.`,
		`"correction" is about the learner's last message only, and about their ${target} and nothing else: grammar, spelling, agreement, word endings, a word that does not exist or cannot be used that way. It is never a comment on what they said. If they ask for a pizza in an ice cream shop, you answer in character that you only have ice cream and set "correction" to null — ordering the wrong thing is not a language mistake.`,
		'Correct as little as possible, and never change what they meant. Fix the wrong word or the wrong ending and leave every other word exactly as they wrote it. Keep their meaning even when it is odd, mistaken about the scene, or rude: if they tell you that you are not their boss, the correction still says that you are not their boss. Never swap a word for one that means something different, never change who or what they were talking about, and never add information they did not give. If you are not sure something is a mistake, it is not one: set "correction" to null.',
		`When their message had no language mistake, "correction" is null. Otherwise "corrected" is {"text","reading"} holding their sentence and nothing else: their whole message rewritten, every word of it and not just the part you changed, but never your own words, never the line you just spoke, and never a sentence you have added.`,
		`"corrected.reading" follows the same rule as "reply.reading", and matters more: when they wrote in romanization it is the only form they can compare against what they typed, so it must be the reading of the corrected sentence, written the way they would type it. "note" is one short sentence in ${native} saying what was wrong, or null.`,
		'Never mention a correction in "reply". The learner sees corrections separately; your spoken line stays in character.',
		`Most turns need no tool call at all. Call add_words only for a word that appears in the learner's own message, that is not in the list below, and that they used correctly. Never for a word you introduced, never for a word you are about to teach them, never for a word they got wrong, and never to be helpful. If you are in any doubt, do not call it: the list is theirs, and it records what they have shown they can use. Fill in "romanization" for every word you add when ${target} is not written in the Latin script.`,
		'A tool result with an "error" field means the call did not happen. Read it and carry on with the conversation rather than repeating the call.'
	].join(' ');

	const block = buildWordBlock(items);
	const words = block
		? `Words the learner already knows, newest first. Build your reply out of these and the most common words of ${target}. At most one word per reply that is not on this list, and only when the scene truly needs it.\n${block}`
		: `The learner has no words in their list yet: use only the most common words of ${target}.`;

	return `${rules}\n\n${words}`;
}

/** Prior turns as dialogue; the tool traffic and the envelope are dropped. */
function historyMessage(turn: ConversationTurn): ChatMessage {
	return turn.role === 'learner'
		? { role: 'user', content: turn.text }
		: { role: 'assistant', content: turn.reply.text };
}

/** `null`/blank normalized away, so a missing field is one state and not three. */
function toLine(raw: { text: string; reading?: string | null }): TargetLine {
	const reading = raw.reading?.trim();
	return reading ? { text: raw.text, reading } : { text: raw.text };
}

/**
 * The spoken line, dug out of JSON that is not the envelope.
 *
 * `{"reply":"..."}` instead of `{"reply":{"text":"..."}}` is what a model
 * writes when `response_format` was dropped and it is going on the prompt
 * alone, so those two shapes are worth knowing. Anything else is not guessed
 * at.
 */
function salvagedLine(json: unknown): string | undefined {
	if (!json || typeof json !== 'object') return undefined;
	const reply = (json as { reply?: unknown }).reply;
	if (typeof reply === 'string' && reply.trim()) return reply.trim();
	if (reply && typeof reply === 'object') {
		const text = (reply as { text?: unknown }).text;
		if (typeof text === 'string' && text.trim()) return text.trim();
	}
	return undefined;
}

/**
 * Reads one teacher completion.
 *
 * A reply that will not parse is not an error: the content becomes the spoken
 * line, with no translation and no correction. The learner loses a translation
 * they may not have tapped for anyway; what they do not lose is the
 * conversation, which is the only thing here worth protecting.
 *
 * The fallback distinguishes prose from a broken envelope, because they degrade
 * differently. Prose *is* the line — a model that ignored the format still said
 * something in character. An envelope is not: dumping it in the bubble would
 * show the learner the plumbing, so a shape that missed the schema gives up its
 * line if it has one, and anything else becomes a pause.
 */
export function parseTeacherReply(raw: string): TeacherReply {
	const text = raw.trim();

	let json: unknown;
	try {
		json = JSON.parse(stripFences(text));
	} catch {
		// Tested on the raw content, not the stripped body: `stripFences` will cut
		// a brace pair out of the middle of a sentence, and a line that happens to
		// contain one is still a line.
		const attemptedEnvelope = text.startsWith('{') || text.startsWith('```');
		return { reply: { text: attemptedEnvelope ? ROUND_LIMIT_REPLY : text } };
	}

	const parsed = teacherReplySchema.safeParse(json);
	if (parsed.success) {
		const { reply, translation, correction } = parsed.data;
		const note = correction?.note?.trim();
		return {
			reply: toLine(reply),
			...(translation?.trim() ? { translation: translation.trim() } : {}),
			...(correction
				? {
						correction: {
							corrected: toLine(correction.corrected),
							...(note ? { note } : {})
						}
					}
				: {})
		};
	}

	return { reply: { text: salvagedLine(json) ?? ROUND_LIMIT_REPLY } };
}

/** The single tool this mode exposes, built once — the def is static. */
function teacherTools(): ToolDef[] {
	return [
		{
			name: addWordsTool.name,
			description: addWordsTool.description,
			parameters: toJsonSchema(addWordsTool.paramsSchema)
		}
	];
}

/**
 * True when a "correction" corrected nothing.
 *
 * Both sides count: a learner who typed the reading gets a rewrite whose
 * *reading* matches what they wrote, and that is just as much a no-op as one
 * whose text does.
 *
 * The two sides are compared differently, and deliberately. The target text is
 * compared exactly, because in the language's own spelling every mark is a
 * mark the learner is answerable for. The reading is compared loosely — tone
 * marks, capitals and syllable spacing dropped — because none of those are
 * things they are being taught, and half of them cannot be typed on the
 * keyboard they have.
 */
function isNoOpCorrection(typed: string, corrected: TargetLine): boolean {
	const written = typed.trim();
	if (written === corrected.text.trim()) return true;
	return corrected.reading ? sameRomanization(written, corrected.reading) : false;
}

/**
 * The real loop: ask, run whatever the model called, ask again.
 *
 * A turn with no tool calls is the end. Anything else appends the assistant's
 * tool-calling message and one tool message per call — in the order the calls
 * came, because the API requires every call id to be answered — and goes round
 * again.
 *
 * **The last round is asked without tools**, which is what guarantees the
 * learner gets a line. Offer a tool on every round and a model that calls one
 * on the final round spends the turn: its result is appended to a conversation
 * nobody asks again, and the learner is handed a pause the model never meant to
 * take. Removing the tool removes the option — the only thing left to do with
 * the tool results already in `messages` is answer.
 */
export async function runTurn(
	history: ConversationTurn[],
	scenario: Scenario,
	text: string,
	profile: Profile,
	opts: TurnOptions = {}
): Promise<TurnResult> {
	const ctx = defaultToolContext(opts.deps);
	const items = await ctx.getAllItems();

	const messages: ChatMessage[] = [
		{ role: 'system', content: buildSystemPrompt(profile, scenario, items) },
		...history.map(historyMessage),
		{ role: 'user', content: text }
	];

	const actions: ActionNote[] = [];
	const tools = teacherTools();
	let lastContent = '';

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const canCallTools = round < MAX_TOOL_ROUNDS - 1;
		const completion = await chatCompletion({
			messages,
			...(canCallTools ? { tools } : {}),
			responseFormat: { schema: teacherReplyJsonSchema(), name: TEACHER_REPLY_SCHEMA_NAME },
			maxTokens: MAX_REPLY_TOKENS,
			temperature: 0.8,
			model: opts.model,
			apiKey: opts.apiKey,
			signal: opts.signal,
			fetchFn: opts.fetchFn
		});

		if (completion.content.trim()) lastContent = completion.content;
		if (completion.toolCalls.length === 0) break;

		messages.push({
			role: 'assistant',
			content: completion.content,
			toolCalls: completion.toolCalls
		});

		for (const call of completion.toolCalls) {
			const outcome = await executeToolCall(call, ctx);
			actions.push({ tool: call.name, summary: outcome.summary, ok: outcome.ok !== false });
			messages.push({
				role: 'tool',
				content: JSON.stringify(outcome.result),
				toolCallId: call.id
			});
		}
	}

	// Out of rounds with nothing said: the words that were filed, were filed.
	const parsed = parseTeacherReply(lastContent || ROUND_LIMIT_REPLY);
	const correction =
		parsed.correction && !isNoOpCorrection(text, parsed.correction.corrected)
			? parsed.correction
			: undefined;

	return {
		teacher: {
			role: 'teacher',
			reply: parsed.reply,
			...(parsed.translation ? { translation: parsed.translation } : {}),
			actions
		},
		...(correction ? { correction } : {})
	};
}
