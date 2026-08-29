# The sync stall — what is established, and how to reproduce it

Status: **open.** Reproduced deterministically in a real browser; cause not found.
Sync should stay off until it is.

## The symptom

Two devices, both holding events the other has not seen. The one that
reconnects pulls part of the other's log, stops, and never pushes its own. No
error is raised at any layer — not in the browser console, not in the Durable
Object. The client *session* reports `isSynced: true, pendingCount: 0`
throughout, because session-to-leader is genuinely healthy; only
leader-to-server is dead. That is why nothing surfaces in the UI, and why the
Settings connection check (which only proves the endpoint is reachable) says
"Connected" the entire time.

## The one hard number

**The reconnecting client stops after exactly 255 or 511 events pulled**, one
short of 256/512.

This survived an intervention test, which nothing else did. Patching
`DO_PAGE_SIZE` in `@livestore/sync-cf`'s Durable Object storage from 256 to 64
changed the *cadence* of arriving batches from `100, 100, 56` to `64, 64, 64`
— proving the patch reached the running code — and the stall still landed at
255 pulled. So the ceiling is **client-side and independent of how the server
pages its eventlog**. There is no literal `255`/`256` in `@livestore/common`,
`adapter-web`, `utils` or `webmesh`, and the queues on the path
(`BucketQueue.make()`) are unbounded, so it is emergent rather than a constant.

## Ruled out, each by experiment

| Hypothesis | How it died |
|---|---|
| The Dexie migration | Skipping `runDexieMigration` entirely: still stalls |
| Client-only events / `clientDocument` | Removing `migrationState` from the schema: still stalls |
| A malformed `parentSeqNum` after rebase | `rebaseEvents` in `syncstate.ts` produces exactly that pairing by design — the first rebased event's parent *is* the generation-0 upstream head |
| `ServerAheadError` and its handling | A wrapper that gated `push` until a `NoMore` page arrived took the error count from 7 per run to 0. The stall was unchanged |
| `initialSyncOptions: Blocking` | Does prevent the premature push, but blocks *boot* for the full timeout whenever the backend is unreachable (measured: 5042ms for a 5s timeout, 157ms with `Skip`). Unacceptable for a local-first app |
| The Durable Object's page size | Changed 256 → 64; cadence moved, stall did not |
| Our Worker (`storeId` rewrite, auth) | Reproduces against stock `makeWorker` with no rewrite and no auth |

## What is not the cause but did confuse the investigation

- **`store.shutdown()` does not flush pending writes** (livestore#416). An early
  reproduction committed 400 events and shut down at once, persisting only ~101,
  which looked exactly like sync losing data on reconnect. It produced a
  confident and wrong report of an upstream data-loss bug. Always settle before
  shutting a store down, and prove any suspected loss by reopening the store
  **with no sync backend** and counting there. See the `gotchas` skill.
- **`_dev.syncStates()` is expensive.** With ~600 events pending, each call
  serialises the whole pending queue and its changesets across the worker
  boundary: measured at 14–15 seconds (`GetLeaderSyncState`). Sampling it every
  15s consumed half of every observation window and distorted the throughput it
  was measuring.
- **Node never reproduces any of this.** `@livestore/adapter-node` completes the
  identical scenario in seconds, including the large-backlog rebase. Every
  finding here required the browser adapter (OPFS + SharedWorker leader).

## Reproducing it

`src/routes/onboarding/harness/+page.svelte` is a temporary page that boots the
real store via `storeReady()` and exposes `window.__h.{commit,count,state}`. It
lives under `/onboarding` deliberately: the layout redirects to onboarding when
there is no profile, and paths under it are exempt.

Drive it with two Chromium profiles (two real devices, each with its own OPFS
and SharedWorker leader):

1. A boots with sync on, commits 400 events.
2. B boots with sync **off**, commits 600 events, closes.
3. A commits 600 more (server now at 1000).
4. B reopens **with sync on**, against the same profile.

B pulls ~100 per batch, stops at 255 or 511, never pushes its 600. A stays at
1000. Roughly seven minutes per run.

## Also worth knowing

Cost is `O(pending × batches)`: every pulled batch rebases the *entire* pending
queue, so a device that has fallen further behind degrades quadratically. That
is separate from the stall, and it is why a device with ~1900 pending events is
hopeless even before it freezes.
