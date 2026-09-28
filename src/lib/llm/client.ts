/**
 * The TypeScript chat client, kept for the one call that is still TypeScript:
 * the romanization backfill (`./romanize`). Everything else goes through the
 * Rust client (`crates/sapling-llm`, `./core`). Also home to `LlmError`, which
 * `./core` rebuilds from the Rust side's error JSON.
 *
 * Runs in the browser with the learner's own key from `localStorage`; takes an
 * injectable `fetch` so it is testable in node.
 */

import { DEFAULT_MODEL, getApiKey, getBaseUrl, getModel } from '$lib/db/settings';
import { recordUsage } from './usage';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const APP_REFERER = 'https://github.com/daanvo/language-learning';
export const APP_TITLE = 'Language Learning';

export interface ChatMessage {
	role: 'system' | 'user';
	content: string;
}

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
	/** A strict JSON schema the reply must match. */
	responseFormat?: { schema: unknown; name: string };
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	fetchFn?: FetchLike;
	/** Overrides the stored key. */
	apiKey?: string;
	/** Overrides the stored endpoint. */
	baseUrl?: string;
}

export interface ChatCompletionResult {
	content: string;
	usage: TokenUsage;
}

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

/** Anthropic only serves CORS headers to a browser that opts in. */
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

function mentionsResponseFormat(body: string): boolean {
	const text = body.toLowerCase();
	return ['response_format', 'response format', 'json_schema', 'structured output'].some((needle) =>
		text.includes(needle)
	);
}

async function readBody(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

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
	choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
	error?: { message?: unknown };
}

function toCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/**
 * One chat completion. Errors are always {@link LlmError}; usage is recorded.
 * An endpoint that rejects structured outputs is asked once more without.
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

	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		'Content-Type': 'application/json'
	};
	// Other endpoints' CORS preflights reject OpenRouter's attribution headers.
	if (baseUrl === OPENROUTER_BASE_URL) {
		headers['HTTP-Referer'] = APP_REFERER;
		headers['X-Title'] = APP_TITLE;
	}
	if (isAnthropicApi(baseUrl)) headers['anthropic-dangerous-direct-browser-access'] = 'true';

	let response: Response;
	for (let attempt = 0; ; attempt++) {
		const withFormat = attempt === 0 && opts.responseFormat !== undefined;
		if (withFormat && opts.responseFormat) {
			body.response_format = {
				type: 'json_schema',
				json_schema: {
					name: opts.responseFormat.name,
					strict: true,
					schema: opts.responseFormat.schema
				}
			};
		} else {
			delete body.response_format;
		}

		try {
			response = await fetchFn(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: opts.signal
			});
		} catch (cause) {
			if (cause instanceof Error && cause.name === 'AbortError') throw cause;
			throw llmError('network', undefined, undefined, cause);
		}

		if (response.ok) break;

		const text = await readBody(response);
		const retryable =
			withFormat &&
			response.status >= 400 &&
			response.status < 500 &&
			![401, 403, 429].includes(response.status) &&
			mentionsResponseFormat(text);
		if (retryable) continue;
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

	const choice = payload.choices?.[0];
	const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
	if (!content.trim()) {
		throw llmError(
			'bad-response',
			choice?.finish_reason === 'length'
				? 'cut off at max_tokens before any content — a thinking model needs a higher cap'
				: 'no message content',
			response.status
		);
	}

	const usage: TokenUsage = {
		promptTokens: toCount(payload.usage?.prompt_tokens),
		completionTokens: toCount(payload.usage?.completion_tokens)
	};
	recordUsage(usage);
	return { content, usage };
}

/** The JSON object in a reply: fences dropped, else the outermost brace pair. */
export function stripFences(text: string): string {
	let out = text.trim();
	const match = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(out);
	if (match) out = match[1].trim();
	if (out.startsWith('{')) return out;
	const start = out.indexOf('{');
	const end = out.lastIndexOf('}');
	if (start >= 0 && end > start) return out.slice(start, end + 1).trim();
	return out;
}
