# Sync

Contracts and runbook. Code: `src/lib/db/`, `src/lib/sync/`, `worker/`.

## Event model

Envelope: `{ id, type, at, device, payload }`. `id` is the set-union key — an
id already in the log is never re-applied. `at` is when the learner did the
thing, and doubles as the last-write-wins input for the two overwrite types.

| type | payload is |
|---|---|
| `itemAdded` | a vocab/grammar item entering the library |
| `itemReviewed` | one graded review, identity `(itemId, at, device)` |
| `reviewAmended` | a re-grade, optionally naming the `at` it replaces |
| `itemUpdated` | a patch of an item's mutable fields |
| `itemDeleted` | a tombstone — the item and its reviews go for good |
| `challengeAdded` | one generated challenge entering the pool |
| `challengeReported` | permanent exclusion of a challenge |
| `challengeServed` | one serve (`timesServed` counts these) |
| `resultLogged` | one answered challenge |
| `profileUpdated` | the whole profile, replaced |

## Merge rules

Applied once per event id, in arrival order (`seq`, else insertion order).

| event | effect |
|---|---|
| `itemAdded` | skip if tombstoned or present; insert with a fresh FSRS card; fold in any reviews that arrived first |
| `itemReviewed` | insert the review row (dedup by id); if `at` is the newest for the item, fold it onto the stored card, else refold the item from all its rows; missing item: row kept, inert |
| `reviewAmended` | delete the replaced row if named; insert the new one; refold the item |
| `itemUpdated` | apply the given fields if `at >= item.updatedAt`; missing item: no-op |
| `itemDeleted` | tombstone the id; delete the item and its reviews |
| `challengeAdded` | skip if present or an unknown challenge type; insert with zeroed counters |
| `challengeServed` | `timesServed += 1`, `lastServedAt = max(lastServedAt, at)`; missing: no-op |
| `challengeReported` | `reported = true`; missing: no-op |
| `resultLogged` | insert the result row; bump that day's count |
| `profileUpdated` | replace the singleton if `at >= profile.updatedAt` |

## Local store

SQLite-WASM (OPFS, SAH-pool VFS) in one dedicated module Worker
(`sqlite.worker.ts`); the window talks to it over a small RPC (`client.ts`).
`events` is the facts log; `items`, `reviews`, `challenges`, `results`,
`daily`, `tombstones`, `profile` are aggregates the materializer maintains —
UI reads never touch `events`. The VFS is exclusive: a second tab gets
"Sapling is already open in another tab." and stops; no leader election.
Node tests run the same DDL and materializer against an in-memory database
(`store.testing.ts`).

## Wire protocol

- `POST /push` `{ events }` → `{ seqs: { id: seq } }` — `INSERT OR IGNORE`;
  an id already stored returns its existing `seq`.
- `GET /pull?after=<seq>&limit=<n≤1000>` → `{ events: [...with seq], latest }`.
- `GET /` → health text.
- Auth: `Authorization: Bearer <phrase>`. The Worker normalises the phrase and
  hashes it (SHA-256) to name the Durable Object room — it never stores a
  phrase, only derives from it. `SYNC_ALLOWED_PHRASES` (comma-separated) can
  narrow a deployment to specific phrases.

## Runbook

- Deploy the Worker: `pnpm sync:deploy`, or connect the repo under Workers
  Builds (watch paths must include `src/lib/sync/*`, not just `worker/*`).
- Restrict who it serves: `wrangler secret put SYNC_ALLOWED_PHRASES`.
- Point a build at it: set `VITE_SYNC_URL` in the Pages project's environment
  variables (build-time; unset means no sync in that build).
- Pair a device: Settings → Sync mints a pairing phrase; enter that phrase on
  another device to join the same room.
- Sync runs at boot, on tab visibility, after a learn session, and on demand
  via Settings' Sync now.

## Import / export

The v3 export envelope is `{ version: 3, exportedAt, events }` — the events
log verbatim, so export/import is complete (pool, serves, results included).
Import unions by event id, skipping ones already present, then rebuilds every
read table from the merged log.
