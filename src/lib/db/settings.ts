/**
 * Browser-local settings.
 *
 * Secrets and device preferences that must never end up in IndexedDB (and so
 * never in an export) live here, in `localStorage`. Every accessor is guarded
 * so the module can be imported from a non-browser context without throwing.
 */

const API_KEY_STORAGE_KEY = 'll.openrouter.apiKey';
const MODEL_STORAGE_KEY = 'll.openrouter.model';
const BASE_URL_STORAGE_KEY = 'll.llm.baseUrl';

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
