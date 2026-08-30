/**
 * Sapling's sync backend: one Durable Object per learner, and nothing else.
 *
 * It assigns every event a sequence number and hands events back in that order.
 * It never merges, never reads a payload and never rewrites anything — every
 * merge rule lives in `src/lib/db/materialize.ts` and is order-independent, so
 * the order here is a cursor, not a decision.
 *
 * Access control is the pairing phrase, carried as `Authorization: Bearer`.
 * The room is named `SHA-256(phrase)` (`room.ts`), so a caller who cannot
 * produce the phrase cannot address the room; `SYNC_ALLOWED_PHRASES` narrows a
 * personal deployment to a fixed set so a leaked URL is not free storage.
 *
 * Only handlers and Durable Object classes may be exported from here — workerd
 * rejects anything else — so the pure request parsing lives in `protocol.ts`.
 *
 * Deploy with `pnpm sync:deploy`, run it locally with `pnpm sync:dev`.
 */
import { normalizePhrase } from '../src/lib/sync/phrase';
import { bearerPhrase, pullRange, pushedEvents } from './protocol';
import { roomIdForPhrase } from './room';

/**
 * `*` because it is not what protects the log — the phrase is. CORS decides
 * which *browser* origins may read a reply and has never applied to `curl`, and
 * pinning it to the Pages origin is not available anyway: preview deployments
 * each get their own hostname.
 */
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'authorization, content-type',
	'Access-Control-Max-Age': '86400'
};

type Env = {
	SYNC_ROOM: DurableObjectNamespace;
	/**
	 * Optional allow-list of pairing phrases, comma-separated. Unset, any
	 * well-formed phrase opens a room; set it (`wrangler secret put
	 * SYNC_ALLOWED_PHRASES`) and only the listed learners are served.
	 */
	SYNC_ALLOWED_PHRASES?: string;
};

interface EventRow extends Record<string, SqlStorageValue> {
	seq: number;
	id: string;
	type: string;
	at: number;
	device: string;
	payload: string;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...CORS }
	});
}

function text(body: string, status = 200): Response {
	return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...CORS } });
}

/** Whether this deployment will serve the given (normalised) phrase. */
function isAllowed(env: Env, phrase: string): boolean {
	const allowed = env.SYNC_ALLOWED_PHRASES?.trim();
	if (!allowed) return true;
	return allowed
		.split(',')
		.map((entry) => normalizePhrase(entry))
		.includes(phrase);
}

/** One learner's log, in the Durable Object's own SQLite. */
export class SyncRoom implements DurableObject {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState) {
		this.sql = ctx.storage.sql;
		// `id` is unique so a re-push is a no-op; `seq` is the total order clients
		// page through, and AUTOINCREMENT keeps it from ever going backwards.
		this.sql.exec(
			`CREATE TABLE IF NOT EXISTS events (
			   seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, type TEXT,
			   at INTEGER, device TEXT, payload TEXT)`
		);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === 'POST' && url.pathname === '/push') return this.push(request);
		if (request.method === 'GET' && url.pathname === '/pull') return this.pull(url);
		return text('Not found\n', 404);
	}

	private async push(request: Request): Promise<Response> {
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return text('Bad request\n', 400);
		}
		const events = pushedEvents(body);
		if (events === undefined) return text('Bad request\n', 400);
		if (events.length === 0) return json({ seqs: {} });

		for (const event of events) {
			this.sql.exec(
				'INSERT OR IGNORE INTO events (id, type, at, device, payload) VALUES (?, ?, ?, ?, ?)',
				event.id,
				event.type,
				event.at,
				event.device,
				JSON.stringify(event.payload ?? null)
			);
		}

		// Read back one by one: an id that was already here has a seq the pusher
		// still needs, and DO SQLite allows at most 100 bound variables per
		// statement, so one `IN (...)` over a page of 500 fails.
		const seqs: Record<string, number> = {};
		for (const event of events) {
			const row = this.sql
				.exec<{ seq: number }>('SELECT seq FROM events WHERE id = ?', event.id)
				.toArray()[0];
			if (row) seqs[event.id] = row.seq;
		}
		return json({ seqs });
	}

	private pull(url: URL): Response {
		const { after, limit } = pullRange(url);
		const rows = this.sql
			.exec<EventRow>(
				'SELECT seq, id, type, at, device, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
				after,
				limit
			)
			.toArray();
		const latest =
			this.sql.exec<{ latest: number | null }>('SELECT MAX(seq) AS latest FROM events').toArray()[0]
				?.latest ?? 0;

		return json({
			events: rows.map((row) => ({
				seq: row.seq,
				id: row.id,
				type: row.type,
				at: row.at,
				device: row.device,
				payload: JSON.parse(row.payload) as unknown
			})),
			latest
		});
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// Before routing: a preflight goes to the same URL as the request it
		// precedes and carries no credentials to check.
		if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

		const url = new URL(request.url);
		if (request.method === 'GET' && url.pathname === '/') {
			return text('Sapling sync backend.\n');
		}
		if (url.pathname !== '/push' && url.pathname !== '/pull') return text('Not found\n', 404);

		// One answer for "no phrase", "malformed phrase" and "not allowed" alike:
		// telling a caller which it got would let them use the endpoint to test
		// phrases.
		const phrase = bearerPhrase(request.headers.get('Authorization'));
		const roomId = phrase === undefined ? undefined : await roomIdForPhrase(phrase);
		if (phrase === undefined || roomId === undefined || !isAllowed(env, phrase)) {
			return text('Unauthorized\n', 401);
		}

		// Cloudflare's own 500 page carries no CORS headers, so a browser would
		// report an uncaught error here as a CORS failure and hide the message.
		try {
			return await env.SYNC_ROOM.get(env.SYNC_ROOM.idFromName(roomId)).fetch(request);
		} catch (error) {
			return text(`${String(error)}\n`, 500);
		}
	}
};
