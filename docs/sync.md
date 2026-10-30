# Sync

Contracts and runbook. Code: `crates/sapling-sync/`, `src/lib/sync/`,
`src/lib/db/`, `worker/`.

## Event model

Envelope: `{ id, type, at, device, payload }`. `id` is the set-union key — an
id already in the log is never re-applied. `at` is when the learner did the
thing, and doubles as the last-write-wins input for the overwrite types.

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
| `textAdded` | a reading text: title, source, media and **exactly one** body — `segments` inline (every event written before content objects, `sentences` in the oldest) or `content`, the hash of an immutable object (`docs/content-objects.md`); both or neither does not parse |
| `textRevised` | `{ textId, content }`: the text's body replaced by another object |
| `textDeleted` | a tombstone — the text goes for good |

A text's body travels beside the log as a **content object** — bytes named
`sha256:<hex>` — and never inside it. The envelope fields `owner`/`objects`/
`retire` that tell the relay which objects an event uses are derived at push
time by `sapling_domain::objects::object_refs` and never stored locally.

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
| `textAdded` | skip if tombstoned or present; record the body as it came, inline segments or a hash — whether the object is here is a read's question |
| `textRevised` | skip if tombstoned; keep the revision if it beats the held one by `(at, device, event id)`; a text not added yet: kept, waits; the newest revision is the text's body |
| `textDeleted` | tombstone the id; delete the text and its revision |

A text whose current body is an object this device does not hold is returned
by no read — library, reader, `clipsFor`, `cuesFor` — until it arrives;
storing the object is enough, nothing is rebuilt.

## Local store

SQLite-WASM (OPFS, SAH-pool VFS) in one dedicated module Worker
(`sqlite.worker.ts`). The window talks to it in domain terms, never SQL: the
`Backend` interface in `protocol.ts` — the repository functions, the sync
operations (`pendingEvents`, `markPushed`, `applyRemote`, the pull cursor,
`followSyncRoom`, and the content-object calls `getObjects`, `putObjects`,
`missingObjects`) and
export/import — is implemented by the Rust core (`crates/sapling-db`,
compiled to wasm and lent the Worker's database through `host.ts`) and
forwarded by `client.ts`, one `postMessage` per call. `events` is the facts
log; `items`, `reviews`, `challenges`, `results`, `tombstones`,
`profile`, `texts`, `textRevisions` and the rest are aggregates the
materializer maintains — UI reads never touch `events`. `objects` sits beside
the log, not under it: hash-verified bytes derived from nothing, so a rebuild
keeps them (a reset clears them). A new text writes its object and its
`textAdded { content }` in one transaction. The log holds every language; the aggregate tables hold only the
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
never an event. Before each push page it derives the page's object fields,
asks `POST /objects/missing` and `PUT`s each missing object the store holds, so
blobs land before the events naming them (one the store never had does not hold
the page back); a `404` there — a relay that predates objects — fails the cycle
with its own message and the page is not pushed, while a page that names no
object pushes as always. After pulling it `GET`s every object a text's current
body names that the store lacks, verifies each against its name and stores it;
a `404` is "not uploaded yet" and simply asked again next cycle, a mismatch or
no answer fails the cycle after the events landed. Every failure — offline, a refused phrase, a store error — is a
returned outcome with a learner-facing message, never an error. `probe` is an
empty pull (`limit=0`) that tells a refused phrase from an unreachable server.
`pair` runs one cycle and reports whether a profile came down the log; it never
writes one, so a second device can join before onboarding would write a
profile that wins last-write-wins everywhere.

**The `seq` stamps and the pull cursor are positions in one room's log**, so
each cycle starts by telling the store which room it is about to talk to
(`room_key`: a hash of the relay URL and the normalised phrase, recorded in
local `meta` as `syncRoom`; `SyncStore::follow_room`, the `Backend`'s
`followSyncRoom`). When the recorded room differs — the learner paired with
another phrase, from Settings, onboarding or anywhere else — or none is
recorded yet, every stamp and the cursor are cleared in one transaction: the
next push sends the whole local log to the new room and the next pull reads it
from `after=0`. That is safe because both directions union by event id — the
relay answers a re-pushed id with the `seq` it already holds and the client
only stamps a pulled event it already has — so following a library costs a
resend, never an event. Re-pairing therefore *merges* this device's library
into the one it now follows. A device that synced before rooms were recorded
makes that full resend once.

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
  Each event may also carry the content-object fields `owner`, `objects`,
  `retire` (`docs/content-objects.md` §4); a malformed one fails the page with
  `400`. They are recorded as sets (`edges`, `retired`), never on the event
  row, and pull never returns them.
- `POST /objects/missing` `{ hashes }` (≤ 500) → `{ missing }`;
  `PUT /objects/<sha256:hex>` the bytes (≤ 1 MiB, hash verified) → `204`;
  `GET /objects/<sha256:hex>` → the bytes or `404`. Nothing deletes.
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
- Sync runs at boot, when the tab is hidden or shown, after a learn session,
  on leaving a text, and on demand via Settings' Sync now. Every trigger but
  Sync now is `$lib/remotes`' `syncRemotes()`, which runs sync before the
  send-only remotes (Taal).

## Import / export

The v3 export envelope is `{ version: 3, exportedAt, events }` — the events
log verbatim, so export/import is complete (pool, serves, results included).
Import unions by event id, skipping ones already present, then rebuilds every
read table from the merged log. A v3 file carries a `textAdded { content }`
but not its object, so such a text imported into a fresh device is hidden
until sync fetches the body; export v4 (`docs/content-objects.md` §6) closes
that.
