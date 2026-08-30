/**
 * The wire protocol, as pure functions.
 *
 * Separate from `index.ts` because workerd refuses any export from the entry
 * module that is not a handler or a Durable Object class — and because these
 * are the parts worth testing in node: a bearer header that normalised
 * differently from the client's would put two devices in two rooms, and an
 * unclamped `limit` would let one request ask for a whole log.
 */
import { isValidPhrase, normalizePhrase } from '../src/lib/sync/phrase';

/** The most events one pull may return, however large a `limit` asks for. */
export const MAX_PULL = 1000;

/** One event on the wire. `payload` is opaque to the backend. */
export interface WireEvent {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: unknown;
}

/**
 * The normalised phrase an `Authorization` header presents, or `undefined`.
 *
 * Normalising here rather than trusting the client is what keeps two devices
 * that typed the phrase differently in the same room.
 */
export function bearerPhrase(header: string | null): string | undefined {
	const match = /^bearer\s+(.+)$/i.exec(header?.trim() ?? '');
	if (!match) return undefined;
	const phrase = normalizePhrase(match[1]);
	return isValidPhrase(phrase) ? phrase : undefined;
}

/** `after`/`limit` off a pull URL, clamped. `limit=0` is a liveness probe. */
export function pullRange(url: URL): { after: number; limit: number } {
	const after = integer(url.searchParams.get('after'), 0);
	const limit = integer(url.searchParams.get('limit'), MAX_PULL);
	return { after: Math.max(after, 0), limit: Math.min(Math.max(limit, 0), MAX_PULL) };
}

function integer(raw: string | null, fallback: number): number {
	if (raw === null) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** The events in a push body, or `undefined` if the body is not one. */
export function pushedEvents(body: unknown): WireEvent[] | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const events = (body as { events?: unknown }).events;
	if (!Array.isArray(events)) return undefined;
	const parsed: WireEvent[] = [];
	for (const raw of events) {
		if (typeof raw !== 'object' || raw === null) return undefined;
		const { id, type, at, device } = raw as Record<string, unknown>;
		if (typeof id !== 'string' || id === '') return undefined;
		if (typeof type !== 'string' || typeof at !== 'number' || typeof device !== 'string') {
			return undefined;
		}
		parsed.push({ id, type, at, device, payload: (raw as { payload?: unknown }).payload });
	}
	return parsed;
}
