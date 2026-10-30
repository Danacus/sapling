/**
 * The wire protocol, as pure functions.
 *
 * Separate from `index.ts` because workerd refuses any export from the entry
 * module that is not a handler or a Durable Object class — and because these
 * are the parts worth testing in node: a bearer header that normalised
 * differently from the client's would put two devices in two rooms, and an
 * unclamped `limit` would let one request ask for a whole log. The same goes
 * for the content-object half (`docs/content-objects.md` §5): a hash check
 * that accepted two spellings of one name would store one body twice.
 */
import { isValidPhrase, normalizePhrase } from './phrase';

/** The most events one pull may return, however large a `limit` asks for. */
export const MAX_PULL = 1000;

/** The most hashes one `POST /objects/missing` may ask about. */
export const MAX_MISSING = 500;

/** The largest object a room stores: Durable Object SQLite rows cap at 2 MB. */
export const MAX_OBJECT_BYTES = 1024 * 1024;

/** The most object hashes one event may declare for its owner. */
export const MAX_EVENT_OBJECTS = 16;

/**
 * The longest `owner`/`retire` string accepted. The client writes
 * `text:<profileId>:<textId>`, far below this; the cap only keeps a caller
 * from using the edge tables as free storage.
 */
export const MAX_OWNER_LENGTH = 512;

/**
 * One event on the wire. `payload` is opaque to the backend.
 *
 * `owner`, `objects` and `retire` are the content-object metadata
 * (`docs/content-objects.md` §4): which objects this event makes an entity use,
 * and which entity it ends. The client derives them at push time; the Worker
 * records them as sets and never stores them on the event row, so a pull
 * never returns them. Each is present only when the pusher sent it — an older
 * client sends none.
 */
export interface WireEvent {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: unknown;
	owner?: string;
	objects?: string[];
	retire?: string;
}

const HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * Whether a string names an object: `sha256:` and 64 lowercase hex. Exactly
 * one spelling per hash, so a room never holds the same bytes twice under two
 * names.
 */
export function isObjectHash(value: unknown): value is string {
	return typeof value === 'string' && HASH.test(value);
}

/** The object name for these bytes — what a `PUT` body must hash to. */
export async function objectHash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Which object a `/objects/<H>` path names: `undefined` for a path that is not
 * one (including `/objects/missing`, its own route), `{ hash: undefined }` for
 * one whose name is malformed — a `400`, not a `404`, so a client with a
 * hashing bug hears about it rather than seeing "absent".
 */
export function objectPath(pathname: string): { hash: string | undefined } | undefined {
	const match = /^\/objects\/([^/]+)$/.exec(pathname);
	if (!match || match[1] === 'missing') return undefined;
	// Not URL-decoded: a well-formed name has nothing to decode.
	return { hash: isObjectHash(match[1]) ? match[1] : undefined };
}

/** The hashes a `POST /objects/missing` body asks about, or `undefined`. */
export function missingQuery(body: unknown): string[] | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const hashes = (body as { hashes?: unknown }).hashes;
	if (!Array.isArray(hashes) || hashes.length > MAX_MISSING) return undefined;
	return hashes.every(isObjectHash) ? hashes : undefined;
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
		const refs = objectRefs(raw as Record<string, unknown>);
		if (refs === undefined) return undefined;
		parsed.push({ id, type, at, device, payload: (raw as { payload?: unknown }).payload, ...refs });
	}
	return parsed;
}

/**
 * The optional object fields of one envelope, or `undefined` if any is
 * malformed — which fails the whole page, like a malformed envelope. `null`
 * reads as absent, so a serialiser that writes `None` as `null` is not
 * refused. An `objects` with no `owner` has nobody to own them: malformed.
 */
function objectRefs(
	raw: Record<string, unknown>
): Pick<WireEvent, 'owner' | 'objects' | 'retire'> | undefined {
	const refs: Pick<WireEvent, 'owner' | 'objects' | 'retire'> = {};
	const { owner, objects, retire } = raw;
	if (owner != null) {
		if (!isOwner(owner)) return undefined;
		refs.owner = owner;
	}
	if (objects != null) {
		if (refs.owner === undefined || !Array.isArray(objects)) return undefined;
		if (objects.length > MAX_EVENT_OBJECTS || !objects.every(isObjectHash)) return undefined;
		refs.objects = objects;
	}
	if (retire != null) {
		if (!isOwner(retire)) return undefined;
		refs.retire = retire;
	}
	return refs;
}

function isOwner(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && value.length <= MAX_OWNER_LENGTH;
}
