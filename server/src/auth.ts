/**
 * Authentication — one middleware, one boundary.
 *
 * v1 is API keys (docs/sync.md §7): the operator provisions a key with
 * `scripts/new-key.ts`, the client sends it as `Authorization: Bearer <key>`,
 * and the server stores only its SHA-256 hash.
 *
 * **This is the OIDC seam.** The plan is to keep the client's transport
 * untouched and swap what happens inside `bearerAuth`: today it hashes the
 * presented token and looks it up, tomorrow it validates an authentik-issued
 * OIDC bearer token and reads the subject out of it. Same header, same client
 * code, same `userId` set on the context — so everything downstream of here
 * must depend only on `c.get('userId')`, never on how it was established.
 */

import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SyncStore } from './db.ts';

/** Hono context typing: every authenticated handler can read `c.get('userId')`. */
export type AuthEnv = { Variables: { userId: string } };

/** SHA-256 hex of a key. The only form of a key the server ever stores. */
export function hashKey(key: string): string {
	return createHash('sha256').update(key, 'utf8').digest('hex');
}

/*
 * On the absence of a constant-time comparison, which is deliberate rather than
 * an oversight: the check below is a SQLite index probe on the SHA-256 of a
 * 256-bit random key. A timing signal there leaks something about the *hash* of
 * a value the attacker already holds, and turning that into the key means
 * inverting SHA-256. Constant-time comparison earns its keep when secrets are
 * compared directly (short, guessable, or attacker-shaped inputs); bolting it
 * onto a hashed high-entropy credential would mean scanning the whole key table
 * instead of using the index, buying nothing. If a future mechanism ever
 * compares a raw secret, that is when `crypto.timingSafeEqual` belongs here.
 */

/** Extracts the token from an `Authorization: Bearer <token>` header. */
function bearerToken(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1]?.trim() || undefined;
}

/**
 * Rejects anything without a known key with 401, otherwise sets `userId`.
 *
 * `skipPaths` exists for `/v1/health`, which must answer an unauthenticated
 * probe (a reverse proxy or uptime check has no key). Everything else under
 * the middleware's mount point is authenticated by default — fail closed, so
 * adding a route can never accidentally add an open one.
 */
export function bearerAuth(store: SyncStore, skipPaths: readonly string[] = []): MiddlewareHandler<AuthEnv> {
	return async (c, next) => {
		if (skipPaths.includes(c.req.path)) return next();

		const token = bearerToken(c.req.header('Authorization'));
		if (!token) {
			// The WWW-Authenticate header is what makes a 401 a 401 rather than
			// a bare refusal; it costs nothing and tells a client *how* to auth.
			c.header('WWW-Authenticate', 'Bearer realm="sapling-sync"');
			return c.json({ error: 'missing bearer token' }, 401);
		}

		const userId = store.userForKeyHash(hashKey(token));
		if (!userId) {
			c.header('WWW-Authenticate', 'Bearer realm="sapling-sync", error="invalid_token"');
			return c.json({ error: 'invalid token' }, 401);
		}

		c.set('userId', userId);
		return next();
	};
}
