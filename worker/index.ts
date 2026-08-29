/**
 * Sapling's sync backend: a Cloudflare Worker in front of one Durable Object
 * per learner.
 *
 * It does very little on purpose, and that is the payoff of the LiveStore
 * migration rather than an omission. It accepts pushed events, assigns them a
 * **global total order**, and relays them on pull. It never merges and never
 * looks inside a payload — every merge rule lives in
 * `src/lib/livestore/materializers.ts` and resolves by *position in the log*.
 * A backend that reordered, deduplicated or rewrote events would change
 * application behaviour without ever reading one.
 *
 * Two things are ours rather than `@livestore/sync-cf`'s stock `makeWorker`:
 *
 * 1. **The room is named by the pairing phrase, not by the client's storeId.**
 *    Clients all send `storeId: 'sapling'` — their store is local, and its name
 *    is a local fact. What separates one learner from another is the phrase, so
 *    this handler rewrites the request to `SHA-256(phrase)` before delegating,
 *    and Cloudflare's `idFromName` isolates the log from there (`room.ts`).
 *
 *    Doing it here rather than on the client is what keeps the client's storeId
 *    fixed forever. If the store's *local* name were derived from the phrase,
 *    then pairing a device would rename its store — which in OPFS means a new,
 *    empty database, with everything written before pairing left behind in the
 *    old one. Nothing on disk moves under this design; pairing changes only
 *    which room the events are relayed through.
 *
 * 2. **Access control is `validatePayload`, and it is stateless.** Possession
 *    of the phrase is the authorisation: the room's name is derived from it, so
 *    a caller who cannot produce it cannot address the room. The optional
 *    `SYNC_ALLOWED_PHRASES` narrows that further to a fixed set, which is what
 *    turns a personal deployment into something other than an open relay.
 *
 * Deploy with `pnpm sync:deploy`; run it locally with `pnpm sync:dev`. See
 * `docs/livestore-sync.md`.
 */
import type { CfTypes } from '@livestore/sync-cf/cf-worker';
import {
	handleSyncRequest,
	makeDurableObject,
	matchSyncRequest
} from '@livestore/sync-cf/cf-worker';

import { normalizePhrase } from '../src/lib/sync/phrase';
import { roomIdForPhrase } from './room';

/**
 * Lets the app read these replies from its own origin.
 *
 * Declared above the Durable Object because the class body below is evaluated
 * at module load and passes this object to `makeDurableObject` — a `const`
 * declared further down would still be in its temporal dead zone.
 *
 * `*` looks broad and is not, because it is not what protects the log. The
 * pairing phrase is: it names the room, it travels in the query string, and a
 * caller who cannot produce it gets a 401 before the Durable Object is ever
 * addressed. CORS only decides which *browser* origins may read a reply, and it
 * has never applied to `curl`, so restricting it would defend against nobody
 * who is not already stopped. Pinning it to the Pages origin is also not
 * available: preview deployments each get their own hostname.
 *
 * (This used to say `*` was safe because the replies "carry no data". That
 * stopped being true when sync moved to HTTP — these responses now carry the
 * eventlog. The reason it is still safe is the phrase, not the emptiness.)
 */
const CORS = { 'Access-Control-Allow-Origin': '*' };

/**
 * One Durable Object per room, storing that room's eventlog in DO SQLite.
 *
 * **HTTP is the only transport enabled**, and that is a deliberate reversal.
 * WebSocket was chosen first because it hibernates between messages, so an idle
 * learner costs no CPU. What that traded away was worse: a hibernating Durable
 * Object drops the in-memory Effect RPC server that owns an in-flight pull,
 * and `@effect/rpc`'s streaming protocol only advances when the *client*
 * acknowledges each page — an acknowledgement it sends after materialising it.
 * A leader slow enough to take ten seconds over a page therefore let the
 * Durable Object hibernate mid-stream, and the acknowledgement then arrived at
 * a freshly-woken server that had never heard of the request and dropped it on
 * the floor. Sync stopped, in silence, with the socket still open. See
 * `docs/sync-stall.md`.
 *
 * Over HTTP a pull is one request. Cloudflare keeps the Durable Object in
 * memory for its duration, there is no cross-message state to lose, and
 * `makeProtocolHttp` reports `supportsAck: false` so the server never waits on
 * the client at all. Between syncs there is no connection, and therefore
 * nothing to hibernate, time out or orphan.
 *
 * The bill is CORS: a cross-origin POST carrying `content-type` and
 * `x-livestore-store-id` is preflighted, and `handleSyncRequest` returns the
 * Durable Object's response verbatim, so the header has to come from here.
 */
export class SyncBackendDO extends makeDurableObject({
	enabledTransports: new Set<'http'>(['http']),
	http: { responseHeaders: CORS }
}) {}

type Env = {
	/**
	 * Typed through `CfTypes` rather than the global `DurableObjectNamespace`.
	 * They are two different declarations of the same thing, and asking
	 * TypeScript to reconcile them inside `@livestore/sync-cf`'s binding-name
	 * lookup makes it give up with "type instantiation is excessively deep".
	 */
	SYNC_BACKEND_DO: CfTypes.DurableObjectNamespace;
	/**
	 * Optional allow-list of pairing phrases, comma-separated.
	 *
	 * Unset, any well-formed phrase opens a room — fine for a private URL
	 * nobody else knows, and the wrong default for a URL that leaks. Set it
	 * (`wrangler secret put SYNC_ALLOWED_PHRASES`) and the Worker will serve
	 * only the listed learners, so a stranger who finds the endpoint cannot use
	 * it as free storage.
	 */
	SYNC_ALLOWED_PHRASES?: string;
};

/**
 * Answers a CORS preflight.
 *
 * Every sync request is now a cross-origin POST carrying `content-type` and
 * `x-livestore-store-id`, and a custom header always earns a preflight. Without
 * this the browser never sends the real request, and the failure surfaces only
 * as a console message inside a Web Worker — which is the *worst* place for
 * this app to hide a fault, given how much of `docs/sync-stall.md` is about
 * failures that made no noise.
 *
 * The requested headers are echoed rather than listed, so that a header
 * `@livestore/sync-cf` adds in some future version cannot silently break
 * pairing. Allowing a request header discloses nothing: the reply is still
 * gated by the phrase.
 *
 * A preflight is answered without checking the phrase, because it carries no
 * credentials to check and rejecting it would break the authorised request
 * behind it. It leaks nothing either — the answer is identical whether or not
 * the phrase that follows is any good.
 */
function preflight(request: Request): Response {
	return new Response(null, {
		status: 204,
		headers: {
			...CORS,
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers':
				request.headers.get('Access-Control-Request-Headers') ??
				'content-type, x-livestore-store-id',
			// Browsers cap this themselves (Chrome at two hours), but without it
			// every RPC call pays for a second round trip.
			'Access-Control-Max-Age': '86400'
		}
	});
}

/** The phrase a client presented, or `undefined` if it presented none. */
function phraseFromPayload(payload: unknown): string | undefined {
	if (typeof payload !== 'object' || payload === null) return undefined;
	const phrase = (payload as { phrase?: unknown }).phrase;
	return typeof phrase === 'string' ? phrase : undefined;
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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Before the routing below, not after: a preflight goes to the same URL as
		// the request it precedes, query string and all, so it would otherwise
		// match as a sync request and be forwarded to a Durable Object that
		// answers it without any CORS header at all.
		if (request.method === 'OPTIONS') return preflight(request);

		const searchParams = matchSyncRequest(request as never);

		if (searchParams === undefined) {
			// Not a sync request. A bare GET is somebody checking the deployment is
			// up; anything else is a mistake worth naming rather than routing.
			const url = new URL(request.url);
			return url.pathname === '/' && request.method === 'GET'
				? new Response('Sapling sync backend.\n', {
						headers: { 'Content-Type': 'text/plain', ...CORS }
					})
				: new Response('Not found\n', {
						status: 404,
						headers: { 'Content-Type': 'text/plain', ...CORS }
					});
		}

		const presented = phraseFromPayload(searchParams.payload);
		const roomId = presented === undefined ? undefined : await roomIdForPhrase(presented);

		// One response for "no phrase", "malformed phrase" and "not on the
		// allow-list" alike: telling a caller *which* of those it got would let
		// them use the endpoint to test phrases.
		if (presented === undefined || roomId === undefined) {
			return new Response('Unauthorized\n', { status: 401, headers: CORS });
		}
		if (!isAllowed(env, normalizePhrase(presented))) {
			return new Response('Unauthorized\n', { status: 401, headers: CORS });
		}

		// Rewrite the request itself, not just the value handed to
		// `handleSyncRequest`: the Durable Object re-reads `storeId` from the URL
		// it is given, so leaving the original in place would have every room
		// recording itself under the client's local name.
		const url = new URL(request.url);
		url.searchParams.set('storeId', roomId);
		const rewritten = new Request(url, request);

		// Awaited into a local rather than returned directly: handing the call's
		// result straight to the declared `Promise<Response>` return type makes
		// TypeScript infer this generic signature against it and give up
		// ("excessively deep"). The `await` breaks that chain.
		const response = await handleSyncRequest({
			request: rewritten as never,
			searchParams: { ...searchParams, storeId: roomId },
			env,
			ctx: ctx as never,
			syncBackendBinding: 'SYNC_BACKEND_DO',
			headers: CORS
		});
		return response as unknown as Response;
	}
};
