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
 * One Durable Object per room, storing that room's eventlog in DO SQLite.
 *
 * WebSocket is the only transport enabled. It is the one a browser client uses,
 * it hibernates between messages so an idle learner costs no CPU, and leaving
 * HTTP off means there is no second, stateless path into the same log to reason
 * about (or to have to answer CORS preflights for).
 */
export class SyncBackendDO extends makeDurableObject({
	enabledTransports: new Set<'ws'>(['ws'])
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
		const searchParams = matchSyncRequest(request as never);

		if (searchParams === undefined) {
			// Not a sync request. A bare GET is somebody checking the deployment is
			// up; anything else is a mistake worth naming rather than routing.
			const url = new URL(request.url);
			return url.pathname === '/' && request.method === 'GET'
				? new Response('Sapling sync backend.\n', {
						headers: { 'Content-Type': 'text/plain' }
					})
				: new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });
		}

		const presented = phraseFromPayload(searchParams.payload);
		const roomId = presented === undefined ? undefined : await roomIdForPhrase(presented);

		// One response for "no phrase", "malformed phrase" and "not on the
		// allow-list" alike: telling a caller *which* of those it got would let
		// them use the endpoint to test phrases.
		if (presented === undefined || roomId === undefined) {
			return new Response('Unauthorized\n', { status: 401 });
		}
		if (!isAllowed(env, normalizePhrase(presented))) {
			return new Response('Unauthorized\n', { status: 401 });
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
			syncBackendBinding: 'SYNC_BACKEND_DO'
		});
		return response as unknown as Response;
	}
};
