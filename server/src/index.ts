/**
 * Process entry point: read env, open the database, listen.
 *
 * All configuration is environment variables — there is no config file and no
 * flags, because the deployment target is one container behind a reverse proxy
 * (docs/sync.md §8) and env is what container runtimes already speak.
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openStore } from './db.ts';

/** Default DB path. Point `SAPLING_DB` at a mounted volume in production. */
const DEFAULT_DB = './sapling.db';
const DEFAULT_PORT = 8787;

const dbPath = process.env.SAPLING_DB ?? DEFAULT_DB;
const port = Number(process.env.PORT ?? DEFAULT_PORT);
// Comma-separated exact origins, e.g. "https://sapling.pages.dev,http://localhost:5173".
// Unset means no CORS headers: fine for curl and for a proxy that serves the
// app from the same origin, fatal for a browser on a different one.
const origins = (process.env.SAPLING_ORIGINS ?? '')
	.split(',')
	.map((o) => o.trim())
	.filter((o) => o.length > 0);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
	console.error(`PORT is not a valid port number: ${process.env.PORT}`);
	process.exit(1);
}

const store = openStore(dbPath);
const app = createApp({ store, origins });

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`sapling-sync listening on :${info.port} (db ${dbPath})`);
	console.log(origins.length ? `CORS origins: ${origins.join(', ')}` : 'CORS: disabled');
});

// SQLite in WAL mode wants a clean close so the -wal file is checkpointed back
// into the database; container stops send SIGTERM, so handle it.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		store.close();
		process.exit(0);
	});
}
