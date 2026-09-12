/**
 * Browser-local settings.
 *
 * Secrets and device preferences that must never end up in the events log (and
 * so never in an export) live here, in `localStorage`. Every accessor is guarded
 * so the module can be imported from a non-browser context without throwing.
 */

const API_KEY_STORAGE_KEY = 'll.openrouter.apiKey';
const MODEL_STORAGE_KEY = 'll.openrouter.model';
const BASE_URL_STORAGE_KEY = 'll.llm.baseUrl';
const REASONING_EFFORT_STORAGE_KEY = 'll.llm.reasoningEffort';
const REQUEST_ITEMS_STORAGE_KEY = 'll.llm.requestItems';

/** Model used when the learner has not picked one. */
export const DEFAULT_MODEL = 'google/gemini-3.7-flash';

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

function read(key: string): string | undefined {
	if (!hasStorage()) return undefined;
	try {
		return localStorage.getItem(key) ?? undefined;
	} catch {
		// Private-mode / disabled-storage browsers throw on access.
		return undefined;
	}
}

function write(key: string, value: string): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore: storage unavailable or full */
	}
}

function remove(key: string): void {
	if (!hasStorage()) return;
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/** The stored OpenRouter API key, or `undefined` if none has been saved. */
export function getApiKey(): string | undefined {
	const key = read(API_KEY_STORAGE_KEY)?.trim();
	return key ? key : undefined;
}

/** Stores the OpenRouter API key. An empty/blank key clears it instead. */
export function setApiKey(key: string): void {
	const trimmed = key.trim();
	if (!trimmed) {
		clearApiKey();
		return;
	}
	write(API_KEY_STORAGE_KEY, trimmed);
}

/** Forgets the stored API key. */
export function clearApiKey(): void {
	remove(API_KEY_STORAGE_KEY);
}

/** The preferred OpenRouter model id; falls back to {@link DEFAULT_MODEL}. */
export function getModel(): string {
	return read(MODEL_STORAGE_KEY)?.trim() || DEFAULT_MODEL;
}

/** Stores the preferred model id. A blank value restores the default. */
export function setModel(model: string): void {
	const trimmed = model.trim();
	if (!trimmed) {
		remove(MODEL_STORAGE_KEY);
		return;
	}
	write(MODEL_STORAGE_KEY, trimmed);
}

/**
 * How hard the generation model may think before answering.
 *
 * Reasoning tokens are billed as output tokens, and a thinking model on its own
 * default can spend thousands per challenge — for lesson generation, where a
 * strict schema already does the structural work, that is usually waste.
 * `'default'` sends nothing and leaves the model's own choice in place. Every
 * other value travels two ways (`reasoning_effort` and `reasoning.effort`; see
 * `$lib/llm/client`) so it lands on both OpenAI-compatible and OpenRouter
 * endpoints.
 */
export type ReasoningEffort = 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'max';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
	'default',
	'minimal',
	'low',
	'medium',
	'high',
	'max'
];

/** Low by default: generation is structured output, not a puzzle. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'low';

/** The generation model's reasoning effort; {@link DEFAULT_REASONING_EFFORT} until changed. */
export function getReasoningEffort(): ReasoningEffort {
	const raw = read(REASONING_EFFORT_STORAGE_KEY);
	return raw && (REASONING_EFFORTS as readonly string[]).includes(raw)
		? (raw as ReasoningEffort)
		: DEFAULT_REASONING_EFFORT;
}

/** Persists the reasoning effort. The default stores nothing, so it stays the default. */
export function setReasoningEffort(effort: ReasoningEffort): void {
	if (effort === DEFAULT_REASONING_EFFORT) {
		remove(REASONING_EFFORT_STORAGE_KEY);
		return;
	}
	write(REASONING_EFFORT_STORAGE_KEY, effort);
}

/** Wants one generation request may carry. Mirrors `REQUEST_ITEMS` in `$lib/llm`. */
export const MAX_REQUEST_ITEMS = 24;

/**
 * An override for the number of wants one generation request carries, or
 * `undefined` to use `REQUEST_ITEMS`' built-in value. Out-of-range or
 * unparseable stored values are treated as absent rather than clamped, so a
 * corrupt entry cannot silently pin generation to a bad size.
 */
export function getRequestItems(): number | undefined {
	const raw = read(REQUEST_ITEMS_STORAGE_KEY);
	if (!raw) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 1 && n <= MAX_REQUEST_ITEMS ? n : undefined;
}

/** Stores the request-size override. `undefined` clears it back to the built-in. */
export function setRequestItems(items: number | undefined): void {
	const n = items === undefined ? Number.NaN : Math.round(items);
	if (!Number.isFinite(n) || n < 1 || n > MAX_REQUEST_ITEMS) {
		remove(REQUEST_ITEMS_STORAGE_KEY);
		return;
	}
	write(REQUEST_ITEMS_STORAGE_KEY, String(n));
}

/**
 * A custom OpenAI-compatible endpoint (e.g. Hetzner Inference), or `undefined`
 * to use OpenRouter. The stored value never carries a trailing slash.
 */
export function getBaseUrl(): string | undefined {
	const url = read(BASE_URL_STORAGE_KEY)?.trim();
	return url ? url : undefined;
}

/** Stores the endpoint base URL. A blank value restores OpenRouter. */
export function setBaseUrl(url: string): void {
	const trimmed = url.trim().replace(/\/+$/, '');
	if (!trimmed) {
		remove(BASE_URL_STORAGE_KEY);
		return;
	}
	write(BASE_URL_STORAGE_KEY, trimmed);
}
