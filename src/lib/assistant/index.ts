/**
 * Public surface of the chat assistant.
 *
 * The UI should only ever need {@link sendChatMessage} and the turn types: it
 * keeps a `ChatTurn[]`, appends the learner's message, awaits the returned
 * {@link AssistantTurn} and renders its `text` plus one line per
 * {@link ActionNote}. The mock/real split, the tool loop and every database
 * write are inside.
 *
 * The assistant's whole write surface is the tool registry (`./tools`): four
 * actions on the learner's word list, each one module. Nothing else in here
 * mutates anything, and a change the learner did not see an action note for did
 * not happen.
 */

export {
	MAX_REPLY_TOKENS,
	MAX_TOOL_ROUNDS,
	ROUND_LIMIT_REPLY,
	buildSystemPrompt,
	runChat,
	sendChatMessage
} from './chat';
export type { ActionNote, AssistantTurn, ChatOptions, ChatTurn } from './chat';

export { OFFLINE_REPLY, mockChat, parseWordLines } from './mock';

export {
	ASSISTANT_TOOLS,
	assistantToolByName,
	defaultToolContext,
	executeToolCall,
	toolDefsForClient
} from './tools';
export type { AssistantToolDef, ToolContext, ToolOutcome } from './tools';
