# Sapling sync server

Self-hosted event-log relay for [Sapling](../README.md). It stores an
append-only log of opaque events per user and hands them back in order; every
merge rule, and every bit of understanding of what an event *means*, lives in
the client. See [`../docs/sync.md`](../docs/sync.md) for the design — this
README is only how to run it.

TypeScript + [Hono](https://hono.dev) + SQLite (better-sqlite3). A few hundred
lines, one file per concern: `src/db.ts` (schema + statements), `src/auth.ts`
(bearer middleware), `src/app.ts` (routes), `src/index.ts` (entry).

## Quickstart

`server/` is an **independent package**, not part of the app's pnpm workspace:
its own `package.json`, lockfile and `node_modules`. Node and pnpm live in the
repo's Nix devShell, so run everything through it from the repo root:

```sh
nix develop -c bash -c 'cd server && pnpm install'
nix develop -c bash -c 'cd server && pnpm new-key --user daan'   # prints a key, once
nix develop -c bash -c 'cd server && pnpm dev'                   # tsx watch, :8787
nix develop -c bash -c 'cd server && pnpm test'                  # vitest, in-memory db
nix develop -c bash -c 'cd server && pnpm typecheck'
```

Smoke test it:

```sh
curl localhost:8787/v1/health
# {"ok":true}

curl -X POST localhost:8787/v1/events -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"device":"laptop","events":[{"id":"6f1a1e64-0d3f-4a2b-9a1e-2b3c4d5e6f70","device":"laptop","at":1700000000000,"type":"item-reviewed","payload":{"itemId":"x","grade":3}}]}'
# {"accepted":1,"latest":1}

curl "localhost:8787/v1/events?after=0" -H "Authorization: Bearer $KEY"
# {"events":[{"seq":1,"id":"6f1a…","device":"laptop","at":1700000000000,"type":"item-reviewed","payload":{…}}],"latest":1}
```

## API

| Route                          | Auth | Body / query                  | Response                          |
| ------------------------------ | ---- | ----------------------------- | --------------------------------- |
| `GET /v1/health`               | no   | —                             | `{ok: true}`                      |
| `POST /v1/events`              | yes  | `{device, events: SyncEvent[]}` | `{accepted, latest}`            |
| `GET /v1/events?after=&limit=` | yes  | `after` (default 0), `limit` (default/max 500) | `{events: (SyncEvent & {seq})[], latest}` |

- **Idempotent push**: `(user, event.id)` is unique, so retrying a batch is
  free — duplicates are counted as accepted, not rejected.
- **`latest`** is the head of the log, not of the page: pull again while the
  last returned `seq` is below it.
- **Limits**: 500 events per request, 64 KB of serialized payload per event
  (`413` past either). One invalid envelope fails the whole request with `400`.
- **Rate limit**: 60 requests/minute per user, in memory (`429` past it).

## Auth

API keys, hashed with SHA-256 at rest. `pnpm new-key [--user ID] [--db PATH]`
mints one and prints it **once** — nothing on the server can recover it. The
client sends `Authorization: Bearer <key>`.

Keys and users are just rows; `--user` groups devices that should share a log.
Two different users' logs never mix, even when they push the same event ids.

## Environment

| Variable          | Default          | Meaning                                                        |
| ----------------- | ---------------- | -------------------------------------------------------------- |
| `SAPLING_DB`      | `./sapling.db`   | SQLite file. In Docker, a path on the mounted volume.           |
| `PORT`            | `8787`           | Listen port.                                                    |
| `SAPLING_ORIGINS` | *(unset)*        | Comma-separated exact browser origins allowed to call `/v1/*`. Unset = no CORS headers. |

`SAPLING_ORIGINS` must list the app's origin (e.g.
`https://sapling.pages.dev,http://localhost:5173`) or browsers will refuse
every response, however healthy the server is.

## Deployment

```sh
# Context is the repo root — the shared event schema lives outside server/.
docker build -f server/Dockerfile -t sapling-sync .

docker run -d --name sapling-sync \
  -p 127.0.0.1:8787:8787 \
  -v sapling-data:/data \
  -e SAPLING_ORIGINS=https://sapling.example \
  sapling-sync

# Mint the first key inside the running container
docker exec sapling-sync node dist/server/scripts/new-key.js --user daan
```

The image runs as the unprivileged `node` user and keeps the database on the
`/data` volume (mount the *directory*: WAL mode writes `-wal`/`-shm` siblings).

**Put it behind the reverse proxy you already run** (Caddy, Traefik, nginx) and
terminate TLS there — bind the container to loopback as above so it is only
reachable through the proxy. **HTTPS is not optional**: the API key travels in
an `Authorization` header on every request, and on plain HTTP that is a
credential in cleartext plus a log an attacker can read and rewrite.

Backups are `cp` of the database directory while stopped, or
`sqlite3 sapling.db ".backup out.db"` while running.
