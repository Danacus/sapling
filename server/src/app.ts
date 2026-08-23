/**
 * The Hono app: three endpoints, exported as a factory so tests can drive it
 * with `app.request(...)` against an in-memory store — no socket, no network,
 * no fixtures on disk (docs/sync.md §6).
 *
 * Everything the server knows about the domain is in this file, and it is
 * almost nothing: an envelope shape, a size cap and a cursor. Payloads pass
 * through untouched.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { SYNC_LIMITS, syncEventSchema, type SyncEvent } from '../../src/lib/sync/events.ts';
import { bearerAuth, type AuthEnv } from './auth.ts';
import type { SyncStore } from './db.ts';

export interface AppOptions {
	store: SyncStore;
	/** Exact browser origins allowed to call `/v1/*`. Empty = no CORS headers at all. */
	origins?: readonly string[];
	/** Requests per user per minute. */
	rateLimitPerMinute?: number;
	/** Injectable clock, so tests are deterministic. */
	now?: () => number;
}

const HEALTH_PATH = '/v1/health';
const DEFAULT_RATE_LIMIT = 60;

/**
 * Per-user token bucket, in process memory.
 *
 * It resets when the process restarts and it is not shared between replicas —
 * both fine, and deliberately so: this is a single-operator, single-container
 * deployment whose real job here is to stop a looping client from filling the
 * disk, not to defend a public API. Anything more (Redis, a persisted counter)
 * would be infrastructure bought for a threat model that does not exist yet.
 */
function rateLimiter(perMinute: number, now: () => number) {
	const buckets = new Map<string, { tokens: number; refilledAt: number }>();

	return (userId: string): boolean => {
		const t = now();
		const bucket = buckets.get(userId) ?? { tokens: perMinute, refilledAt: t };
		// Continuous refill: tokens come back at perMinute/60_000 per ms, so a
		// client that paces itself is never blocked and a burst drains once.
		const refill = ((t - bucket.refilledAt) / 60_000) * perMinute;
		bucket.tokens = Math.min(perMinute, bucket.tokens + refill);
		bucket.refilledAt = t;
		if (bucket.tokens < 1) {
			buckets.set(userId, bucket);
			return false;
		}
		bucket.tokens -= 1;
		buckets.set(userId, bucket);
		return true;
	};
}

export function createApp(options: AppOptions): Hono<AuthEnv> {
	const { store, origins = [], rateLimitPerMinute = DEFAULT_RATE_LIMIT, now = Date.now } = options;
	const app = new Hono<AuthEnv>();
	const allow = rateLimiter(rateLimitPerMinute, now);

	// CORS first, and before auth: a browser preflight carries no Authorization
	// header, so an authenticated OPTIONS would 401 every cross-origin request.
	// Hono's cors() answers OPTIONS itself and never reaches the chain below.
	if (origins.length > 0) {
		app.use(
			'/v1/*',
			cors({
				origin: (origin) => (origins.includes(origin) ? origin : null),
				allowMethods: ['GET', 'POST', 'OPTIONS'],
				allowHeaders: ['Authorization', 'Content-Type'],
				maxAge: 86_400
			})
		);
	}

	// The only unauthenticated route (§6). `bearerAuth` is mounted on the whole
	// of `/v1/*` and skips exactly this path, so every route added later is
	// authenticated unless someone deliberately opens it.
	app.get(HEALTH_PATH, (c) => c.json({ ok: true }));

	app.use('/v1/*', bearerAuth(store, [HEALTH_PATH]));

	app.use('/v1/*', async (c, next) => {
		if (c.req.path === HEALTH_PATH) return next();
		if (!allow(c.get('userId'))) {
			return c.json({ error: 'rate limit exceeded' }, 429);
		}
		return next();
	});

	/**
	 * Push. `{ device, events }` → `{ accepted, latest }`.
	 *
	 * Validation is all-or-nothing: one malformed envelope fails the whole
	 * request with 400. That is the opposite of the app's LLM-parsing
	 * philosophy (salvage what you can from an unreliable generator) and it is
	 * the right call here, because the producer is *our own client*. A partial
	 * accept would leave the client's outbox believing events landed that
	 * didn't, and would hide the bug that produced them. Fail loudly instead.
	 */
	app.post('/v1/events', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'body must be JSON' }, 400);
		}

		if (typeof body !== 'object' || body === null) {
			return c.json({ error: 'body must be an object' }, 400);
		}
		const { device, events } = body as { device?: unknown; events?: unknown };
		// The body-level `device` is the pushing device. Each event carries its
		// own (they may differ: a device can relay events it pulled and re-owns
		// nothing), so this one is only checked for shape.
		if (typeof device !== 'string' || device.length === 0) {
			return c.json({ error: 'device must be a non-empty string' }, 400);
		}
		if (!Array.isArray(events)) {
			return c.json({ error: 'events must be an array' }, 400);
		}

		if (events.length > SYNC_LIMITS.maxEventsPerRequest) {
			return c.json(
				{ error: `at most ${SYNC_LIMITS.maxEventsPerRequest} events per request` },
				413
			);
		}

		const parsed: SyncEvent[] = [];
		for (const [index, raw] of events.entries()) {
			const result = syncEventSchema.safeParse(raw);
			if (!result.success) {
				return c.json(
					{ error: `invalid event at index ${index}`, issues: result.error.issues },
					400
				);
			}
			// Cap the payload, not the request: one runaway event is a client
			// bug worth surfacing, and a per-event limit keeps the check
			// independent of how a client batches.
			const bytes = Buffer.byteLength(JSON.stringify(result.data.payload ?? null), 'utf8');
			if (bytes > SYNC_LIMITS.maxPayloadBytes) {
				return c.json(
					{
						error: `payload of event at index ${index} exceeds ${SYNC_LIMITS.maxPayloadBytes} bytes`
					},
					413
				);
			}
			parsed.push(result.data);
		}

		const { accepted, latest } = store.appendEvents(c.get('userId'), parsed, now());
		return c.json({ accepted, latest });
	});

	/**
	 * Pull. `?after=SEQ&limit=N` → `{ events, latest }`, seq-ascending.
	 *
	 * `latest` is the head of the *log*, not of this page: it is how a client
	 * knows whether to ask again (`events.at(-1).seq < latest`), which is the
	 * whole pagination protocol.
	 */
	app.get('/v1/events', (c) => {
		const rawAfter = c.req.query('after');
		const after = rawAfter === undefined ? 0 : Number(rawAfter);
		if (!Number.isInteger(after) || after < 0) {
			return c.json({ error: 'after must be a non-negative integer' }, 400);
		}

		const rawLimit = c.req.query('limit');
		const limit = rawLimit === undefined ? SYNC_LIMITS.maxEventsPerRequest : Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1) {
			return c.json({ error: 'limit must be a positive integer' }, 400);
		}
		// An over-large limit is clamped rather than rejected: the client asked
		// for "as much as you'll give me", and answering that is friendlier than
		// failing a sync over a number.
		const capped = Math.min(limit, SYNC_LIMITS.maxEventsPerRequest);

		const userId = c.get('userId');
		return c.json({
			events: store.readEvents(userId, after, capped),
			latest: store.latestSeq(userId)
		});
	});

	return app;
}
