/**
 * The chat loop: one learner message in, one assistant turn out.
 *
 * This is the app's own miniature tool server. The model is handed the four
 * word-list tools (`./tools`) and nothing else; every change to the learner's
 * vocabulary that comes out of a conversation went through one of them, which
 * is what keeps "the assistant edited my list" auditable — each executed call
 * leaves an {@link ActionNote} on the turn, and the UI can show exactly what
 * happened.
 *
 * Three properties are deliberate:
 *
 * - **A turn is atomic.** `sendChatMessage` runs the whole tool exchange and
 *   returns the finished turn; the caller keeps a flat `ChatTurn[]` and never
 *   sees a half-resolved state. Tool calls and their results are *not* replayed
 *   into later turns — prior turns are context, in prose, so a long
 *   conversation does not drag every JSON payload along with it.
 * - **Failures are data.** A tool that could not do the job returns an error
 *   result (see `executeToolCall`), so the model reads it and recovers inside
 *   the same turn. Only `LlmError` escapes, and its message is already UI-ready.
 * - **Nothing here touches the database.** Every side effect goes through the
 *   injected {@link ToolContext}, so the loop is testable against fakes and the
 *   offline mock drives the very same executors.
 */

import { chatCompletion, isMockMode } from '$lib/llm';
import type { ChatMessage, FetchLike } from '$lib/llm';
import type { Profile } from '$lib/types';
import { defaultToolContext, executeToolCall, toolDefsForClient } from './tools';
import type { ToolContext } from './tools';
import { mockChat } from './mock';

/** One executed tool call, for the UI to show under the assistant's reply. */
export interface ActionNote {
	/** The tool's registry name, e.g. `add_words`. */
	tool: string;
	/** The tool's own one-liner, e.g. `Added 2 words: hola, adiós`. */
	summary: string;
	/** False when the call failed; the model will usually have said so too. */
	ok: boolean;
}

/** An assistant reply, plus what it did on the way. */
export interface AssistantTurn {
	role: 'assistant';
	text: string;
	actions: ActionNote[];
}

/** The conversation as the UI holds it: prose only, no tool plumbing. */
export type ChatTurn = { role: 'user'; text: string } | AssistantTurn;

/** Test seams and per-call overrides. Production passes none of them. */
export interface ChatOptions {
	signal?: AbortSignal;
	fetchFn?: FetchLike;
	apiKey?: string;
	model?: string;
	/** Overrides part of the {@link ToolContext} — the in-memory store tests use. */
	deps?: Partial<ToolContext>;
}

/**
 * How many model turns one message may take.
 *
 * Five is room for read-then-write-then-confirm plus a retry after a failed
 * call, and a hard stop on a model that keeps calling tools instead of
 * answering — every round is a paid request.
 */
export const MAX_TOOL_ROUNDS = 5;

/** Reply budget. A word-list assistant that needs more than this is rambling. */
export const MAX_REPLY_TOKENS = 1024;

/** Used when the model spent its rounds on tools and never wrote a reply. */
export const ROUND_LIMIT_REPLY =
	'I made the changes I could; ask me again if something is missing.';

/**
 * One assistant turn: the real loop when a key is configured, the deterministic
 * offline mock otherwise — the same dispatch `getBatch` makes in `$lib/llm`, so
 * the whole assistant is usable (and developable) without spending tokens.
 */
export async function sendChatMessage(
	history: ChatTurn[],
	text: string,
	profile: Profile,
	opts: ChatOptions = {}
): Promise<AssistantTurn> {
	if (isMockMode()) return mockChat(history, text, profile, opts);
	return runChat(history, text, profile, opts);
}

/**
 * The system prompt.
 *
 * Everything in it is either a fact the model cannot look up (who the learner
 * is, how many words they have) or a rule about *this* app's tools. The word
 * count is read once per turn from the same context the tools write through, so
 * the model can answer "how many words do I know" without a tool call — and
 * knows to reach for `list_words` when the answer needs the words themselves.
 */
export function buildSystemPrompt(profile: Profile, wordCount: number): string {
	return [
		`You manage the vocabulary list of a learner of ${profile.targetLanguage} whose native language is ${profile.nativeLanguage}, at ${profile.level} level. Their list currently holds ${wordCount} word${wordCount === 1 ? '' : 's'}.`,
		`Reply in ${profile.nativeLanguage}, in one or two short sentences. Plain text, no markdown, no praise, no restating the request.`,
		'Use the tools to read and change the list; never claim a change you did not make with a tool.',
		`When ${profile.targetLanguage} is not written in the Latin script, always fill in "romanization" for every word you add.`,
		'Deleting is irreversible: never call remove_word unless the learner has explicitly confirmed in this conversation that that word should go. If they were vague, ask first.',
		'A tool result with an "error" field means the call did not happen. Read it, correct the arguments or tell the learner, and do not repeat the same call unchanged.',
		'When the learner asks something that is not about their word list, answer it briefly as their language tutor.'
	].join(' ');
}

/** Prior turns as plain messages; the tool traffic that produced them is dropped. */
function historyMessage(turn: ChatTurn): ChatMessage {
	return turn.role === 'user'
		? { role: 'user', content: turn.text }
		: { role: 'assistant', content: turn.text };
}

/**
 * The real loop: ask, run whatever the model called, ask again.
 *
 * A turn with prose and no tool calls is the end. Anything else appends the
 * assistant's tool-calling message and one tool message per call — in the order
 * the calls came, because the API requires every call id to be answered — and
 * goes round again.
 */
export async function runChat(
	history: ChatTurn[],
	text: string,
	profile: Profile,
	opts: ChatOptions = {}
): Promise<AssistantTurn> {
	const ctx = defaultToolContext(opts.deps);
	const items = await ctx.getAllItems();

	const messages: ChatMessage[] = [
		{ role: 'system', content: buildSystemPrompt(profile, items.length) },
		...history.map(historyMessage),
		{ role: 'user', content: text }
	];

	const actions: ActionNote[] = [];
	let lastText = '';

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const completion = await chatCompletion({
			messages,
			tools: toolDefsForClient(),
			maxTokens: MAX_REPLY_TOKENS,
			model: opts.model,
			apiKey: opts.apiKey,
			signal: opts.signal,
			fetchFn: opts.fetchFn
		});

		const said = completion.content.trim();
		if (said) lastText = said;
		if (completion.toolCalls.length === 0) return { role: 'assistant', text: lastText, actions };

		messages.push({
			role: 'assistant',
			content: completion.content,
			toolCalls: completion.toolCalls
		});

		for (const call of completion.toolCalls) {
			const outcome = await executeToolCall(call, ctx);
			actions.push({
				tool: call.name,
				summary: outcome.summary,
				ok: outcome.ok !== false
			});
			messages.push({
				role: 'tool',
				content: JSON.stringify(outcome.result),
				toolCallId: call.id
			});
		}
	}

	// Out of rounds: the tools that ran, ran — say so rather than losing them.
	return { role: 'assistant', text: lastText || ROUND_LIMIT_REPLY, actions };
}
