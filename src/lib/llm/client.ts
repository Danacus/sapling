/**
 * Minimal OpenRouter chat-completions client.
 *
 * Runs in the browser only: the API key lives in local storage / IndexedDB and
 * is supplied by the learner in Settings. There is no server to proxy through.
 */

/** OpenRouter's OpenAI-compatible endpoint. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	/** Structured-output request; see `challengeBatchJsonSchema()`. */
	responseFormat?: unknown;
	temperature?: number;
	signal?: AbortSignal;
}

export interface ChatResponse {
	/** Raw assistant message content. */
	content: string;
	/** Model actually used (OpenRouter may route elsewhere). */
	model: string;
}

/** Reads the stored OpenRouter API key. TODO: back with the settings store. */
export function getApiKey(): string | undefined {
	throw new Error('TODO: getApiKey');
}

export function setApiKey(_key: string): void {
	throw new Error('TODO: setApiKey');
}

/** Single chat completion call. TODO: fetch, error mapping, retries. */
export async function chat(_request: ChatRequest): Promise<ChatResponse> {
	throw new Error('TODO: chat');
}
