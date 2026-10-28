/**
 * The endpoint's model list, for the model picker: `GET {baseUrl}/models`, the
 * OpenAI-compatible shape, read leniently so OpenRouter's extra fields (name,
 * context, pricing) show when present. A failure is an empty list — the picker
 * stays a free-text field — and the endpoint is passed in, never read here.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ModelInfo {
	id: string;
	name?: string;
	contextLength?: number;
	/** USD per token, as the endpoint states it. */
	promptPrice?: number;
	completionPrice?: number;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, Promise<ModelInfo[]>>();

function number(value: unknown): number | undefined {
	const n = typeof value === 'string' ? Number.parseFloat(value) : value;
	return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** `data[]` of a `/models` reply; entries without a string id are skipped. */
export function parseModels(body: unknown): ModelInfo[] {
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) return [];
	const seen = new Set<string>();
	const models: ModelInfo[] = [];
	for (const entry of data as Record<string, unknown>[]) {
		const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
		const name =
			typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined;
		models.push({
			id,
			name,
			contextLength: number(entry.context_length),
			promptPrice: number(pricing.prompt),
			completionPrice: number(pricing.completion)
		});
	}
	return models;
}

/**
 * The models `baseUrl` (blank: OpenRouter) lists, memoised per endpoint for the
 * page's lifetime. A failure resolves empty and is forgotten, so the next call retries.
 */
export function fetchModels(
	baseUrl: string | undefined,
	apiKey?: string,
	fetchFn: FetchFn = (url, init) => fetch(url, init)
): Promise<ModelInfo[]> {
	const base = baseUrl?.trim().replace(/\/+$/, '') || OPENROUTER_BASE_URL;
	const cached = cache.get(base);
	if (cached) return cached;
	const key = apiKey?.trim();
	const request = fetchFn(`${base}/models`, {
		headers: key ? { Authorization: `Bearer ${key}` } : {}
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const models = parseModels(await response.json());
			if (models.length === 0) throw new Error('no models');
			return models;
		})
		.catch(() => {
			cache.delete(base);
			return [];
		});
	cache.set(base, request);
	return request;
}

export interface ModelChoice {
	id: string;
	/** Absent for the typed id offered as-is. */
	model?: ModelInfo;
}

/**
 * The listed models matching `query` (every whitespace token a substring of
 * the id or name), exact id first, then id prefixes, else list order — plus
 * the query itself, last, when no listed id is exactly it.
 */
export function searchModels(models: readonly ModelInfo[], query: string): ModelChoice[] {
	const typed = query.trim();
	const tokens = typed.toLowerCase().split(/\s+/).filter(Boolean);
	const needle = typed.toLowerCase();
	const ranked = models
		.map((model, index) => {
			const haystack = `${model.id} ${model.name ?? ''}`.toLowerCase();
			if (!tokens.every((token) => haystack.includes(token))) return undefined;
			const id = model.id.toLowerCase();
			const rank = !needle ? 2 : id === needle ? 0 : id.startsWith(needle) ? 1 : 2;
			return { model, index, rank };
		})
		.filter((entry) => entry !== undefined)
		.sort((a, b) => a.rank - b.rank || a.index - b.index);
	const choices: ModelChoice[] = ranked.map(({ model }) => ({ id: model.id, model }));
	if (typed && !models.some((model) => model.id === typed)) choices.push({ id: typed });
	return choices;
}

function price(perToken: number): string {
	const perMillion = perToken * 1_000_000;
	if (perMillion === 0) return '$0';
	return `$${perMillion.toFixed(perMillion < 0.01 ? 4 : 2)}`;
}

function tokens(count: number): string {
	if (count >= 1_000_000) return `${+(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
	return String(count);
}

/** "$0.10 / $0.40 per 1M · 128K context", whichever parts the endpoint stated. */
export function modelDetail(model: ModelInfo): string {
	const parts: string[] = [];
	if (model.promptPrice !== undefined && model.completionPrice !== undefined) {
		parts.push(
			model.promptPrice === 0 && model.completionPrice === 0
				? 'Free'
				: `${price(model.promptPrice)} / ${price(model.completionPrice)} per 1M`
		);
	}
	if (model.contextLength) parts.push(`${tokens(model.contextLength)} context`);
	return parts.join(' · ');
}
