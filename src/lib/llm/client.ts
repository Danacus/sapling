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

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

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
	/** Raw assistant message content. */
	content: string;
	usage: TokenUsage;
	/** Model actually used (OpenRouter may route elsewhere). */
	model: string;
	/** True when the structured-output request had to be dropped and retried. */
	schemaDropped: boolean;
}

/** Why an LLM call failed, in terms the UI can act on. */
export type LlmErrorKind =
	| 'no-key'
	| 'auth'
	| 'rate-limit'
	| 'server'
	| 'network'
	| 'bad-response';

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
	choices?: { message?: { content?: unknown } }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
	error?: { message?: unknown };
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

	const body: Record<string, unknown> = { model, messages: opts.messages };
	if (opts.temperature !== undefined) body.temperature = opts.temperature;
	if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

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

	const content = payload.choices?.[0]?.message?.content;
	if (typeof content !== 'string' || !content.trim()) {
		throw llmError('bad-response', 'no message content', response.status);
	}

	const usage: TokenUsage = {
		promptTokens: toCount(payload.usage?.prompt_tokens),
		completionTokens: toCount(payload.usage?.completion_tokens)
	};
	recordUsage(usage);

	return { content, usage, model: payload.model ?? model, schemaDropped };
}
