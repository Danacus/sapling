/**
 * The chat assistant. The loop, the tools and the offline mock are Rust
 * (`crates/sapling-llm`); this module hands them the learner's word list.
 * Tool traffic never outlives a turn: the page keeps prose only.
 */

import type {
	AddWordsParams,
	AssistantTurn,
	ChatTurn,
	ConversationAction,
	LearnerProfile,
	NewWord,
	ToolOutcome
} from '$lib/db/generated/index';
import { callLlm } from '$lib/llm';
import type { CallOptions, ToolContext } from '$lib/llm';
import { defaultToolContext } from './context';

export type { AddWordsParams, AssistantTurn, ChatTurn, NewWord, ToolContext, ToolOutcome };
/** One tool call a turn made, for the note under the reply. */
export type ActionNote = ConversationAction;
export { defaultToolContext };

/** One assistant turn. Only `LlmError` (or a failing store) rejects. */
export function sendChatMessage(
	history: ChatTurn[],
	text: string,
	profile: LearnerProfile,
	opts: CallOptions = {}
): Promise<AssistantTurn> {
	return callLlm(
		'sendChatMessage',
		{ profile, history, text },
		{ ...opts, tools: opts.tools ?? defaultToolContext() }
	);
}

/**
 * `add_words` with no model: the one route by which vocabulary enters the
 * collection, whoever asks.
 */
export function addWords(words: NewWord[], opts: CallOptions = {}): Promise<ToolOutcome> {
	return callLlm('addWords', { words }, { ...opts, tools: opts.tools ?? defaultToolContext() });
}
