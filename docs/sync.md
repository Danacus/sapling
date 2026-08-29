# Sapling Sync — design (draft for iteration)

Status: **superseded in part, 2026-08-29.** This document is the spec for the
first Sapling "service": multi-device synchronization of progress, vocabulary,
and the challenge pool. §11 records the decisions made during iteration; §12
records all four implementation slices as done.

> **What has changed.** The storage layer has moved from Dexie/IndexedDB to
> LiveStore (WASM SQLite with a built-in event log), which supplies the
> append-only log and the total order this document specified by hand. §2's
> core idea survives intact and is now someone else's implementation. **§4's
> ordering rule does not** — see the note at the head of that section. §§6–9
> describe the homebrew protocol and server, which still exist in
> `src/lib/sync/` and `server/` but are no longer wired to the app; they are
> removed once the new path has carried real data.

## 1. Goals and non-goals

Goals:

- Sync **items** (vocabulary + FSRS state), the **challenge pool** (content +
  serve bookkeeping + reports), the **results log**, and the **profile** across
  devices. The day streak is *derived* from the results log rather than synced
  as a counter — set-unioned results make it consistent everywhere for free.
- **Local-first stays non-negotiable.** The app must remain fully functional
  with sync unconfigured, the server unreachable, or the feature turned off
  mid-life. Sync failures degrade silently (the audio-layer rule, applied to
  networking).
- **No lost reviews.** Two devices reviewing the same word before syncing must
  converge to a card state that reflects *both* reviews.
- Self-hosted, minimal server. The server must not need to understand the data
  — which keeps it small, keeps all semantics client-side, and leaves the door
  open to end-to-end encryption without redesign.

Non-goals (for this iteration):

- Real-time / live sync. Manual + on-session-end is the target cadence.
- Multi-user collaboration or shared pools.
- End-to-end encryption (designed *for*, not built now — see §10).
- Syncing secrets or device preferences (OpenRouter key, sync key, `ll.*`
  prefs, TTS caches stay device-local, matching the existing export policy).

## 2. Core idea: state is a fold over an event log

Nearly all Sapling state is already event-shaped, and the hard state — FSRS
cards — is *derived*: `KnowledgeItem.history` is an append-only list of
`(at, grade)` entries and `reviewCard` (`$lib/srs`) is pure. So the merge rule
for concurrent reviews is not "pick a winner", it is:

> **Union the events, order deterministically, replay.**

Two devices that have applied the same *set* of events hold byte-identical
state, regardless of arrival order. No CRDT library; the domain already is
one: histories are grow-only sets, card state is a deterministic fold,
counters are sums of deduplicated increments, deletions are tombstone events.

The local IndexedDB stays exactly what it is today — a materialized view the
UI reads. Sync adds an **outbox** of locally produced events and an **apply
engine** for remote ones. The server stores and relays opaque events; it never
merges anything.

## 3. Event model

One append-only log per user. Every event:

```ts
interface SyncEvent {
  /** Client-minted RFC 4122 UUID (`crypto.randomUUID()`); the server
      dedupes on it (idempotent push) and rejects non-UUID ids. */
  id: string;
  /** Stable per-device id (minted once, stored in localStorage). */
  device: string;
  /** Client wall-clock, epoch ms. Ordering key (see §5 on skew). */
  at: number;
  type: string;      // discriminant, see below
  /** zod-validated per type on the client; may be `null`, never absent
      (the server serializes it into a NOT NULL column). */
  payload: unknown;
}
```

The server wraps each stored event with a `seq` — the pull cursor. In the
implementation `seq` is one global `AUTOINCREMENT` counter: strictly
increasing over the whole table, therefore strictly increasing within any one
user's subsequence, which is all a cursor needs (and `AUTOINCREMENT`
specifically, so a delete can never cause rowid reuse and rewind a cursor).

Event types and payloads (client-validated with zod; the server treats
payloads as opaque):

| type                | payload                                                        |
|---------------------|----------------------------------------------------------------|
| `item-added`        | item content: `id, kind, term, meaning, romanization?, notes?, introducedAt` (no card, no history) |
| `item-reviewed`     | `itemId, at, grade` — exactly a history entry                  |
| `review-amended`    | `itemId, at, grade, replaces?` — the re-grade carries its **own** timestamp (`amendResult` stamps a fresh `now`); `replaces` names the `at` of the entry it supersedes, absent when there was nothing to replace. Cards are re-folded from history timestamps, so the event must describe the history the emitting device actually holds. |
| `item-updated`      | `itemId, fields` — LWW field patch (romanization backfill, note edits) |
| `item-deleted`      | `itemId` — tombstone                                           |
| `challenge-added`   | the full immutable `Challenge` content + `generatedAt, topic?` |
| `challenge-served`  | `challengeId` — one serve                                      |
| `challenge-reported`| `challengeId` — permanent exclusion                            |
| `result-logged`     | the `ChallengeResult`                                          |
| `profile-updated`   | the full `Profile` — LWW by `at`                               |

**Retired:** `xp-banked` (`day, amount`), which existed while the app had XP.
Old logs still hold these events. They are now simply an unknown type, and
`parseSyncPayload`/apply drop unknown types silently (§4, §1's degrade-silently
rule) — that is the designed degradation, not a migration step. Old
`profile-updated` payloads carrying the retired `dailyGoalXp` field still parse:
`z.object` strips unknown keys.

## 4. Merge semantics (the apply engine)

> **Superseded, 2026-08-29 — the ordering rule changed.**
>
> This section originally specified a total order of its own: *sort by
> `(at, device, id)`, then replay*, so that the merged state was a function of
> the event **set** and never of arrival order. `sync/apply.ts` implemented it,
> and carried the bookkeeping to reconstruct it on every apply.
>
> The order is now **the eventlog's own**. LiveStore gives every client the
> same totally ordered log and rebases a client's unsynced events onto the
> remote ones it had not seen, so materializing in log order is already
> deterministic across devices. Rather than rebuild the old order on top of a
> perfectly good one, the merge rules use it directly.
>
> The consequence is a real behaviour change, taken deliberately rather than
> inherited: **"last write wins" now means last to reach the log, not the
> greatest `at`.** The old rule trusted a wall clock, which meant a device
> whose clock ran fast could stamp an edit into the future and win every
> contest indefinitely, including against edits genuinely made later. Log order
> is a better proxy for causality than a clock nobody can audit.
>
> Three things fell out of the schema with it, each because the property it
> defended is now guaranteed rather than merely likely: the `patchAt` /
> `patchDevice` / `patchEventId` columns, the `tombstones` table, and the
> `supersededReviews` table. An `item-deleted` cannot lose to a later
> `item-added` because only a device already holding the item can delete it,
> and a `review-amended` cannot precede the review it replaces because the same
> device wrote both moments apart — and rebase moves a client's events as a
> block without reordering them internally.
>
> Everything below still holds *except* the ordering sentence and the two
> last-write-wins rules. The identity rules — a history entry is
> `(itemId, at, device)`, serves and results dedupe by event id — are unchanged
> and were never orderings in the first place.

Deterministic order everywhere: sort by `(at, device, id)`.

- **Items**: `item-added` creates (or is a no-op if the id exists). The FSRS
  card is **recomputed by replaying the item's merged history** through
  `reviewCard` from a fresh card — cheap (tens of entries per item) and exact.
  `item-reviewed` inserts into `history` keyed by `(at, device)`;
  `review-amended` replaces the entry with matching `at`. `item-updated`
  applies LWW per field. `item-deleted` wins over everything concurrent
  (a review of a word deleted elsewhere applies to nothing — acceptable;
  deleting is rare and deliberate).
- **Challenges**: content is immutable, identified by challenge id.
  `timesServed` = count of distinct applied `challenge-served` events (exact,
  since events dedupe by id — better than max-merge); `lastServedAt` = max
  `at` among them. `reported` = OR.
- **Results**: set-union by event id. Append-only. The day streak is a pure
  fold over this log (`activityByDay` → `streakFrom` in `$lib/db/day`), so it
  needs no merge rule of its own.
- **Profile**: whole-object LWW by `at`.
- **Unknown types** (including retired ones) are dropped, and the rest of the
  batch still applies.

Application is idempotent and commutative by construction, so incremental
apply (only new events, in server-seq order) reaches the same state as a full
replay. Local events are applied to the view immediately at write time, as
today; a device skips its own events when they come back in a pull.

## 5. Edge cases, decided

- **Clock skew**: *largely moot since 2026-08-29* (§4). Nothing is ordered by
  client `at` any more, so a wrong clock can no longer decide a merge. `at`
  survives only where it is domain data: it is half of a history entry's
  identity, and it is what FSRS folds on. The residual exposure is therefore
  the one this bullet always described and always accepted — a skewed clock
  writes a review at the wrong instant, which shifts that item's schedule by
  the skew. No vector clocks, and now no tie-breaks either.
- **Amend after sync**: `review-amended` may arrive after the original
  review was already applied on another device; replacing by `(itemId, at)`
  and re-folding the history makes it exact, in any arrival order.
- **Genesis (first sync of a device with existing data)**: synthesize real
  events from current state — `item-added` + one `item-reviewed` per history
  entry, `challenge-added` (+ `timesServed` synthetic `challenge-served`
  events stamped at `lastServedAt`), `result-logged` per row, one
  `profile-updated`. No snapshot special case: the log
  is the only mechanism. Synthetic serve timestamps are approximate; harmless
  (they only order recycling).
- **Two devices with independent pre-sync data**: not merged intelligently in
  v1. Same *term* generated on both devices yields two items (different ids).
  Recommendation and documented happy path: enable sync on the primary device
  first; start secondary devices empty and let them pull. Term-level dedup
  across devices is an open question (§11).
- **Log growth**: unbounded in v1 and genuinely small (an active learner
  produces a few hundred events/week; a year is a few MB). Compaction via a
  signed snapshot event is a designed-for later step, not built now.

## 6. Protocol

Plain HTTPS + JSON, bearer auth:

```
POST /v1/events            body: { device, events: SyncEvent[] }
                           → { accepted: number, latest: seq }
                           Idempotent: unique (user, event.id); duplicates
                           are counted as accepted, not errors.

GET  /v1/events?after=SEQ&limit=500
                           → { events: (SyncEvent & { seq })[], latest: seq }

GET  /v1/health            → { ok: true }
```

A sync = push outbox, then pull from the stored cursor until `latest`,
applying as it goes; both halves retry-safe and interruption-safe (the outbox
only drains entries the server acknowledged; the cursor only advances after
apply). Batching at 500 events keeps requests small.

Protocol details settled in implementation: an over-large `limit` is clamped
to 500 rather than rejected ("give me as much as you'll give" must not fail a
sync); the body-level `device` on a push is shape-checked only — each event's
own `device` is authoritative; caps are 500 events/request and 64 KB of
serialized payload per event (shared constants in `src/lib/sync/events.ts`);
the pull shape `SyncEvent & { seq }` is exported as `storedSyncEventSchema`
from the same module.

## 7. Authentication

**v1: API keys.** Provisioned by the operator (a tiny CLI or SQL insert),
stored server-side as SHA-256 hashes, presented as `Authorization: Bearer
<key>`. On the client the key follows the OpenRouter-key precedent exactly:
`ll.syncKey` + `ll.syncServer` in localStorage, never in IndexedDB, never in
the JSON export.

**Later: OIDC via authentik**, without touching the client's transport: auth
is one server middleware that today compares hashed keys and tomorrow
validates OIDC bearer tokens (authentik can also mint long-lived personal
tokens as a halfway step). Same header, same client code. Full login flows
(PKCE in an installed PWA) are deliberately deferred until there's a second
user to justify them.

## 8. Server

- **Stack: TypeScript + Hono + SQLite** (better-sqlite3), in `server/` of
  this repo. The decisive argument for TS-in-monorepo: the zod event schemas
  are shared with the client instead of duplicated — one source of truth for
  what a valid event is. (The server still doesn't *interpret* payloads; it
  validates the envelope and stores.)
- Two tables: `keys(hash, user_id, created_at)` and
  `events(user_id, seq, event_id, device, at, type, payload, created_at)`
  with unique `(user_id, event_id)`.
- Deployment: single container (Dockerfile), reverse-proxied by whatever
  already fronts the host (Caddy/Traefik); CORS allowlist for the app origin;
  basic per-key rate limiting.
- Target size: a few hundred lines plus tests.

## 9. Client integration

New `src/lib/sync/` module, following house rules:

- **Capture at the single write path, only while sync is enabled.**
  Repositories are the only Dexie access; each mutating repository function
  appends the corresponding event to a new Dexie `outbox` table *in the same
  transaction* as the write, so view and log can never disagree. New
  `syncState` table holds the cursor and device id. Capture is **opt-in**:
  it starts when sync is configured, and the genesis synthesis (§5) covers
  everything from before that moment — genesis must exist regardless, so
  always-on capture would buy nothing while growing an outbox forever on
  devices that never sync.
- **Apply engine is pure** (`applyEvents(state, events) → state` per
  collection) and fully unit-tested in node — the merge rules in §4 are the
  test suite. Dexie touching stays in thin untested wrappers, per the
  project's testing philosophy.
- **Apply cannot re-capture, by construction**: remote folds are written by
  exactly one dedicated repository function (`mergeSyncSnapshot`) that never
  touches the outbox — no `capture:false` flag to forget. It diffs by
  reference identity (the pure engine returns untouched rows as the same
  objects), so a three-review merge writes three rows.
- Counts (`challenge-served`, `result-logged`) dedupe
  by remembered event ids in `syncState` bookkeeping; everything else dedupes
  from the data it produces. Bookkeeping is stored sorted so identical event
  sets yield byte-identical snapshots regardless of pull batching.
- **Engine, not components, calls sync**: a `runSync()` orchestrator (push,
  pull, apply, advance cursor) invoked from three places — a Settings "Sync
  now" button, fire-and-forget after `finish()`/`quit()` banks a session, and
  fire-and-forget on app load (so a device picks up what the others did
  overnight before the first session is planned; it must never delay boot —
  the start screen renders from local state and re-plans if a sync lands).
  No background periodic sync in v1.
- **UI**: a "Sync" card in Settings — server URL, API key, status line
  (last sync, pending outbox count), Sync now. Sync must never block play.
- FSRS recompute reuses `$lib/srs` replay; no new scheduling code.

## 10. Security & privacy

- HTTPS only; keys hashed at rest; payload size caps; rate limits.
- What leaves the device: vocabulary, challenge content (LLM-generated
  lesson text), review history, results, profile — including the
  free-text `about`. What never leaves: OpenRouter key, sync key, prefs, TTS
  caches. The Settings card says this in one sentence.
- **E2EE path (designed-for)**: because the server already treats payloads as
  opaque, encrypting `payload` client-side (passphrase-derived symmetric key)
  is a client-only change plus losing server-side envelope validation.

## 11. Decisions log (formerly open questions)

1. **Outbox capture: opt-in.** Starts when sync is configured; genesis (§5)
   covers everything earlier. Always-on would buy nothing (genesis must exist
   anyway) while growing an outbox forever on never-syncing devices.
2. **Server: TS + Hono + SQLite, in-repo** (`server/`), for zod schema
   sharing with the client.
3. **Term-level dedup across independently seeded devices: deferred.** The
   documented happy path stands — enable sync on the primary device first,
   start secondaries empty.
4. **Cadence: manual ("Sync now") + after a session banks + on app load**,
   all fire-and-forget, never blocking boot or play.
5. **Compaction: deferred** until logs measurably matter.
6. **Generation proxy: a later service.** The auth/middleware design here is
   what it will plug into.

## 12. Implementation slices (once this doc is stable)

1. **Done.** `server/`: skeleton, auth middleware, event tables, push/pull
   endpoints, tests. Deployable container.
2. **Done.** Client: device id, outbox capture in repositories, genesis
   synthesis, pure apply engine + tests.
3. **Done.** Client: `runSync()` (`src/lib/sync/run.ts`) + the Settings
   "Sync" card (`src/routes/settings/+page.svelte`) + the after-session
   trigger (`finish()`/`quit()` in `src/routes/learn/+page.svelte`).
4. **Done.** Polish: pagination hardening, rate limits (both server-side,
   §6/§8), the on-load trigger (a boot-guarded call in
   `src/routes/+layout.svelte`, fire-and-forget and outside the
   per-navigation `$effect`), and docs (this file, `CLAUDE.md`,
   `server/README.md`).
