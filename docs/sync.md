# Sync

Contracts and runbook. Code: `crates/sapling-sync/`, `src/lib/sync/`,
`src/lib/db/`, `worker/`.

## Event model

Envelope: `{ id, type, at, device, payload }`. `id` is the set-union key — an
id already in the log is never re-applied. `at` is when the learner did the
thing, and doubles as the last-write-wins input for the two overwrite types.

The original language library keeps these event shapes unchanged. Facts for an
additional language use the opaque `profileEvent` type, whose payload is
`{ profileId, type, payload }`. A client that predates multiple languages keeps
such a row in its log and syncs it onward, but cannot accidentally materialise
it into its singleton library. The Worker remains payload-blind.

Push and export carry log rows verbatim; only materialization interprets a
payload, and a row it cannot read is skipped, never dropped from the log. So a
row a newer build wrote — an unknown `type`, or a payload whose schema has
since widened — survives a round trip through an older device untouched.

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
| `itemUpdated` | fold per field over the `itemAdded` fields in `(at, device)` order, read from the log; missing item: waits until `itemAdded` lands |
| `itemDeleted` | tombstone the id; delete the item and its reviews |
| `challengeAdded` | skip if present or an unknown challenge type; insert with zeroed counters |
| `challengeServed` | `timesServed += 1`, `lastServedAt = max(lastServedAt, at)`; missing: no-op |
| `challengeReported` | `reported = true`; missing: no-op |
| `resultLogged` | insert the result row; bump that day's count |
| `profileUpdated` | replace the singleton if `at >= profile.updatedAt` |

## Local store

SQLite-WASM (OPFS, SAH-pool VFS) in one dedicated module Worker
(`sqlite.worker.ts`). The window talks to it in domain terms, never SQL: the
`Backend` interface in `protocol.ts` — the repository functions, the sync
operations (`pendingEvents`, `markPushed`, `applyRemote`, the pull cursor) and
export/import — is implemented by the Rust core (`crates/sapling-db`,
compiled to wasm and lent the Worker's database through `host.ts`) and
forwarded by `client.ts`, one `postMessage` per call. `events` is the facts
log; `items`, `reviews`, `challenges`, `results`, `tombstones`,
`profile` are aggregates the materializer maintains — UI reads never touch
`events`. The log holds every language; the aggregate tables hold only the
language selected on this device. Profiles form the small global index, and a
switch rebuilds the other aggregates from that profile's events. The active
profile id lives in local `meta`, so selecting a language does not switch other
devices. The VFS is exclusive: a second tab gets "Sapling is already open in
another tab." and stops; no leader election. Node tests run the same wasm
build, DDL and materializer against an in-memory database
(`backend.testing.ts`).

## Client

The client is `crates/sapling-sync`, and it is host-agnostic: a cycle is
`run(transport, store, url, phrase)`, with the HTTP request and the database
both injected and the URL and phrase as arguments. One cycle pushes pending
events in pages of 500 and stamps the `seq` of each one the relay
acknowledged, then pulls pages of 1000 from the stored cursor until the cursor
reaches `latest`, applying each page before moving the cursor past it. A local
event keeps a missing `seq` until the relay has answered for it, and the cursor
never passes an unapplied page, so an interruption costs a repeated request and
never an event. Every failure — offline, a refused phrase, a store error — is a
returned outcome with a learner-facing message, never an error. `probe` is an
empty pull (`limit=0`) that tells a refused phrase from an unreachable server.
`pair` runs one cycle and reports whether a profile came down the log; it never
writes one, so a second device can join before onboarding would write a
profile that wins last-write-wins everywhere.

The web host runs it on the window thread through the wasm build's `sync`
export (`src/lib/sync/core.ts`), lending `fetch` and the window's `Backend`.
What stays in TypeScript is the device's own state: the phrase and the on/off
switch in `localStorage` (`config.ts`), the build's `VITE_SYNC_URL` (`url.ts`),
the last outcome for Settings, the triggers, and joining a cycle already
running (`run.ts`). A native host lends `sapling-store`'s `CoreHandle` as the
store and a transport of its own; `crates/sapling-store/tests/sync.rs` runs two
devices through an in-memory relay that way.

## Pairing phrase

20 characters of Crockford base32 (100 bits), minted from host-drawn random
bytes and shown in groups of five. Anything typed is normalised — upper-cased,
everything outside `0-9A-Z` dropped, `I`/`L` read as `1` and `O` as `0` — and
must then be exactly 20 characters of the alphabet. The client's rules are
`phrase.rs`; the Worker keeps its own copy (`worker/phrase.ts`), and
`crates/sapling-sync/fixtures/phrases.json` is the shared set of cases both run
against, since two normalisations that differ are two rooms.

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
  Builds (the Worker imports nothing outside `worker/`, so `worker/*` is
  enough as a watch path).
- Restrict who it serves: `wrangler secret put SYNC_ALLOWED_PHRASES`.
- Point a build at it: set `VITE_SYNC_URL` in the Pages project's environment
  variables (build-time; unset means no sync in that build).
- Pair a device: Settings → Sync mints a pairing phrase; enter that phrase on
  another device to join the same room. A new device pairs from the onboarding
  screen, before any profile is written.
- Sync runs at boot, on tab visibility, after a learn session, and on demand
  via Settings' Sync now.

## Import / export

The v3 export envelope is `{ version: 3, exportedAt, events }` — the events
log verbatim, so export/import is complete (pool, serves, results included).
Import unions by event id, skipping ones already present, then rebuilds every
read table from the merged log.
