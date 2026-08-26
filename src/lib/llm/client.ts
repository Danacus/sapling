/**
 * Minimal OpenRouter chat-completions client.
 *
 * Runs in the browser: the API key lives in `localStorage` (see
 * `$lib/db/settings`) and is supplied by the learner in Settings. There is no
 * server to proxy through.
 *
 * The client is deliberately stateless and takes an injectable `fetch`, so the
 * whole LLM layer can be unit-tested in node without a network.
 */

import { DEFAULT_MODEL, getApiKey, getBaseUrl, getModel } from '$lib/db/settings';
import { recordUsage } from './usage';

/** OpenRouter's OpenAI-compatible endpoint; used unless the learner set a custom one. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Attribution headers; OpenRouter shows these on the app leaderboard. */
export const APP_REFERER = 'https://github.com/daanvo/language-learning';
export const APP_TITLE = 'Language Learning';

/**
 * One tool the model may call, in the caller's terms. `parameters` is a JSON
 * Schema object describing the arguments; it is passed through verbatim.
 */
export interface ToolDef {
	name: string;
	description: string;
	parameters: unknown;
}

/**
 * One tool call the model asked for. `arguments` is the raw JSON string the
 * model produced — the client never parses it, so callers own validation (a
 * model is free to emit malformed JSON here).
 */
export interface ToolCallRequest {
	id: string;
	name: string;
	arguments: string;
}

/** System and user turns: plain text, nothing else. */
export interface TextMessage {
	role: 'system' | 'user';
	content: string;
}

/** `content` may be empty when the turn is nothing but tool calls. */
export interface AssistantMessage {
	role: 'assistant';
	content: string;
	toolCalls?: ToolCallRequest[];
}

/** The result of running one tool call, fed back for the next turn. */
export interface ToolResultMessage {
	role: 'tool';
	content: string;
	toolCallId: string;
}

export type ChatMessage = TextMessage | AssistantMessage | ToolResultMessage;

/**
 * `'json'` asks for plain JSON-object mode; the object form additionally pins a
 * JSON schema (OpenAI-style structured outputs, which OpenRouter forwards).
 */
export type ResponseFormat = 'json' | { schema: unknown; name: string };

/** Anything with `fetch`'s shape; lets tests inject a fake. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
}

export interface ChatCompletionOptions {
	messages: ChatMessage[];
	/** Defaults to the learner's stored model, else {@link DEFAULT_MODEL}. */
	model?: string;
	responseFormat?: ResponseFormat;
	/**
	 * Tools the model may call. Sent on every attempt — orthogonal to
	 * `responseFormat`. An empty array is the same as omitting it.
	 */
	tools?: ToolDef[];
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	/** Injectable `fetch`; defaults to `globalThis.fetch`. */
	fetchFn?: FetchLike;
	/**
	 * Overrides the stored key. Only for tests and callers that already hold a
	 * key; production code should let it fall through to `getApiKey()`.
	 */
	apiKey?: string;
	/**
	 * Overrides the stored endpoint. Production code should let it fall through
	 * to `getBaseUrl()` (custom endpoint) and then {@link OPENROUTER_BASE_URL}.
	 */
	baseUrl?: string;
}

export interface ChatCompletionResult {
	/** Raw assistant message content; `''` when the turn was only tool calls. */
	content: string;
	/** Tool calls the model asked for, empty when it made none. */
	toolCalls: ToolCallRequest[];
	usage: TokenUsage;
	/** Model actually used (OpenRouter may route elsewhere). */
	model: string;
	/** True when the structured-output request had to be dropped and retried. */
	schemaDropped: boolean;
}

/** Why an LLM call failed, in terms the UI can act on. */
export type LlmErrorKind = 'no-key' | 'auth' | 'rate-limit' | 'server' | 'network' | 'bad-response';

/** Every failure out of `$lib/llm` is one of these. `message` is UI-ready. */
export class LlmError extends Error {
	readonly kind: LlmErrorKind;
	/** HTTP status, when the failure came from a response. */
	readonly status?: number;

	constructor(kind: LlmErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'LlmError';
		this.kind = kind;
		this.status = options?.status;
	}
}

/** Default human-readable text per failure kind. */
const MESSAGES: Record<LlmErrorKind, string> = {
	'no-key': 'No OpenRouter API key yet. Add one in Settings to generate lessons.',
	auth: 'OpenRouter rejected the API key. Check it in Settings.',
	'rate-limit': 'OpenRouter is rate-limiting this key. Wait a moment and try again.',
	server: 'OpenRouter had a problem on its side. Try again in a minute.',
	network: 'Could not reach OpenRouter. Check your connection and try again.',
	'bad-response': 'The model returned something unusable. Try again.'
};

function llmError(kind: LlmErrorKind, detail?: string, status?: number, cause?: unknown): LlmError {
	const message = detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind];
	return new LlmError(kind, message, { status, cause });
}

/**
 * Anthropic's API only serves CORS headers when the request opts in with
 * `anthropic-dangerous-direct-browser-access` ("dangerous" because it implies
 * the key ships to a browser — which is this app's whole model anyway); without
 * it the preflight fails with "Disallowed CORS origin".
 */
function isAnthropicApi(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname;
		return host === 'anthropic.com' || host.endsWith('.anthropic.com');
	} catch {
		return false;
	}
}

function kindForStatus(status: number): LlmErrorKind {
	if (status === 401 || status === 403) return 'auth';
	if (status === 429) return 'rate-limit';
	if (status >= 500) return 'server';
	return 'bad-response';
}

/**
 * Cheap models routinely reject or ignore `response_format`. The error text is
 * not standardized, so sniff for the usual suspects.
 */
function mentionsResponseFormat(body: string): boolean {
	const text = body.toLowerCase();
	return (
		text.includes('response_format') ||
		text.includes('response format') ||
		text.includes('json_schema') ||
		text.includes('structured output')
	);
}

function buildResponseFormat(format: ResponseFormat): unknown {
	if (format === 'json') return { type: 'json_object' };
	return {
		type: 'json_schema',
		json_schema: { name: format.name, strict: true, schema: format.schema }
	};
}

/** Our message shapes in OpenAI's wire spelling; nothing else reaches the API. */
function buildMessage(message: ChatMessage): unknown {
	if (message.role === 'tool') {
		return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
	}
	if (message.role === 'assistant' && message.toolCalls?.length) {
		return {
			role: 'assistant',
			content: message.content,
			tool_calls: message.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: { name: call.name, arguments: call.arguments }
			}))
		};
	}
	return { role: message.role, content: message.content };
}

function buildTool(tool: ToolDef): unknown {
	return {
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.parameters }
	};
}

async function readBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

/** Pulls a useful sentence out of an OpenRouter error body. */
function errorDetail(body: string): string | undefined {
	if (!body) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		const error = (parsed as { error?: { message?: unknown } })?.error;
		if (error && typeof error.message === 'string') return error.message.slice(0, 200);
	} catch {
		/* not JSON; fall through */
	}
	return body.slice(0, 200);
}

interface CompletionPayload {
	model?: string;
	choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
	error?: { message?: unknown };
}

/**
 * Defensive: an entry without an id or a function name is unanswerable, so it
 * is dropped rather than surfaced. Absent or non-string `arguments` become
 * `'{}'` — a no-argument call is the common cause and is perfectly callable.
 */
function parseToolCalls(raw: unknown): ToolCallRequest[] {
	if (!Array.isArray(raw)) return [];
	const calls: ToolCallRequest[] = [];
	for (const entry of raw) {
		const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
		const id = call?.id;
		const name = call?.function?.name;
		if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) continue;
		const args = call.function?.arguments;
		calls.push({ id, name, arguments: typeof args === 'string' ? args : '{}' });
	}
	return calls;
}

function toCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * One chat completion.
 *
 * Errors are always {@link LlmError}. Usage is recorded to the local counters
 * (see `./usage`) on every successful call.
 */
export async function chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
	const apiKey = opts.apiKey?.trim() || getApiKey();
	if (!apiKey) throw llmError('no-key');

	const model = opts.model?.trim() || getModel() || DEFAULT_MODEL;
	const baseUrl = (opts.baseUrl?.trim() || getBaseUrl() || OPENROUTER_BASE_URL).replace(/\/+$/, '');
	const fetchFn = opts.fetchFn ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
	if (!fetchFn) throw llmError('network', 'no fetch implementation available');

	const body: Record<string, unknown> = { model, messages: opts.messages.map(buildMessage) };
	if (opts.temperature !== undefined) body.temperature = opts.temperature;
	if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
	// No `tool_choice`: the default (auto) is what every caller wants.
	if (opts.tools?.length) body.tools = opts.tools.map(buildTool);

	let schemaDropped = false;
	let response: Response;

	// Attempt 1 with the requested response_format; attempt 2 (only when the
	// model complained about it) without, leaving zod as the safety net.
	for (let attempt = 0; ; attempt++) {
		const withFormat = attempt === 0 && opts.responseFormat !== undefined;
		if (withFormat && opts.responseFormat) {
			body.response_format = buildResponseFormat(opts.responseFormat);
		} else {
			delete body.response_format;
		}

		// The attribution headers are OpenRouter-specific; other endpoints' CORS
		// preflights reject them, so they only go where they are understood.
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		};
		if (baseUrl === OPENROUTER_BASE_URL) {
			headers['HTTP-Referer'] = APP_REFERER;
			headers['X-Title'] = APP_TITLE;
		}
		if (isAnthropicApi(baseUrl)) {
			headers['anthropic-dangerous-direct-browser-access'] = 'true';
		}

		try {
			response = await fetchFn(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: opts.signal
			});
		} catch (cause) {
			if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
			if (cause instanceof Error && cause.name === 'AbortError') throw cause;
			throw llmError('network', undefined, undefined, cause);
		}

		if (response.ok) break;

		const text = await readBody(response);
		const retryable =
			withFormat &&
			response.status >= 400 &&
			response.status < 500 &&
			response.status !== 401 &&
			response.status !== 403 &&
			response.status !== 429 &&
			mentionsResponseFormat(text);

		if (retryable) {
			schemaDropped = true;
			continue;
		}
		throw llmError(kindForStatus(response.status), errorDetail(text), response.status);
	}

	const raw = await readBody(response);
	let payload: CompletionPayload;
	try {
		payload = JSON.parse(raw) as CompletionPayload;
	} catch (cause) {
		throw llmError('bad-response', 'response was not JSON', response.status, cause);
	}

	if (payload.error && typeof payload.error.message === 'string') {
		throw llmError('bad-response', payload.error.message.slice(0, 200), response.status);
	}

	const message = payload.choices?.[0]?.message;
	const toolCalls = parseToolCalls(message?.tool_calls);
	const content = typeof message?.content === 'string' ? message.content : '';
	// A tool-calling turn legitimately has no prose; anything else must.
	if (!content.trim() && toolCalls.length === 0) {
		throw llmError('bad-response', 'no message content', response.status);
	}

	const usage: TokenUsage = {
		promptTokens: toCount(payload.usage?.prompt_tokens),
		completionTokens: toCount(payload.usage?.completion_tokens)
	};
	recordUsage(usage);

	return { content, toolCalls, usage, model: payload.model ?? model, schemaDropped };
}
