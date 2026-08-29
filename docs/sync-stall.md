# The sync stall — what it was, and what was done about it

Status: **addressed by changing transport, 2026-08-29.** The mechanism below was
established by reading `@livestore/*` and `@effect/rpc` rather than by
reproducing the stall again, and the fix removes its preconditions rather than
patching it. It has **not** been re-tested in a browser — the harness that
produced the original reproduction is gone, and the replacement check runs
through the node adapter, which cannot reach this failure at all. Treat the
first real two-browser sync as the actual verification.

## The fix, in one paragraph

Sync moved from WebSocket to **HTTP** (`worker/index.ts`), and the client pulls
**once at boot** instead of reactively (`livePull: false`, in
`src/lib/livestore/livestore.worker.ts`). That kills the stall three times over:
`makeProtocolHttp` reports `supportsAck: false`, so the acknowledgement coupling
below does not exist; a pull is a single request, so there is no hibernation
window to fall into; and there is no socket, so there is no ping watchdog to
tear one down. `docs/livestore-sync.md` has the design and what was verified.

## The symptom

Two devices, both holding events the other has not seen. The one that
reconnects pulls part of the other's log, stops, and never pushes its own. No
error is raised at any layer — not in the browser console, not in the Durable
Object. The client *session* reports `isSynced: true, pendingCount: 0`
throughout, because session-to-leader is genuinely healthy; only
leader-to-server is dead. That is why nothing surfaces in the UI, and why the
Settings connection check (which only proves the endpoint is reachable) says
"Connected" the entire time.

## The mechanism

The initial pull is **lock-step, and the acknowledgement is gated on the
client's materialisation speed.**

1. `@effect/rpc`'s `RpcServer.streamEffect` sends one page, closes a latch and
   awaits it (`RpcServer.ts:391-399`). Nothing more goes out until the client
   sends `Ack`.
2. The client sends that `Ack` only *after* `mailbox.offerAll(values)` completes
   (`RpcClient.ts:545-556`), on a `Mailbox.make(16)` whose numeric capacity means
   the `"suspend"` strategy (`effect/src/internal/mailbox.ts:487`) — so it blocks
   while full.
3. That `offerAll` runs **inside the WebSocket read loop**
   (`@livestore/utils/src/effect/RpcClient.ts:52-72`), whose consumer is the
   leader's `Stream.tap` → `SyncState.merge` → rollback and re-materialise. In
   the diverged case that is O(pending) work per page, on OPFS, in a
   SharedWorker.

So the gap between acknowledgements *is* the leader's per-page cost, and once it
passes ~10 seconds two independent, silent failures are armed:

- **The Durable Object hibernates out from under the stream.** `webSocketMessage`
  only queues the message and returns (`common-cf/src/ws-rpc/ws-rpc-server.ts:206-211`),
  so Cloudflare sees an idle object while the pull sits parked; its RPC server
  and in-flight fiber live in a plain in-memory `Map` (`:148`) that eviction
  destroys. The late `Ack` then reaches a freshly-woken server and
  `RpcServer.ts:180-183` is `latch ? latch.open : Effect.void` — **a silent
  no-op**. `setWebSocketAutoResponse` answers pings at the edge without waking
  the object, so the socket stays open and healthy throughout.
- **The client tears its own socket down.** With the read loop parked, `Pong`
  frames go unprocessed, `pinger` opens its timeout latch (`RpcClient.ts:192`),
  and the socket fails `OpenTimeout`. That error sets `isConnected: false` and is
  then *deliberately swallowed* (`:114-127` — the early return, and the
  `logError` beside it is commented out). `isConnected` gates both the pull tap
  (`LeaderSyncProcessor.ts:831`) and the push loop (`:869`, `:873`), which is why
  "never pushes its own" came for free. Nothing re-pings: `connect` is called
  once at leader boot (`make-leader-thread-layer.ts:147`). And `@effect/rpc` does
  not re-issue in-flight requests after a reconnect — `entries` is cleared only
  on scope shutdown (`RpcClient.ts:268-286`) — so the pull is orphaned.

Node never reproduced it because its leader acknowledges in milliseconds and
never reaches either threshold.

## The "one hard number" was a counting artifact

This file used to lead with *"the client stops after exactly 255 or 511 events,
one short of 256/512"* and treat that as an emergent client-side ceiling. It
was almost certainly neither hard nor a ceiling. The harness counted
`rows.filter(r => r.id.startsWith('a-'))` — and device A's log does not begin
with `a-0`, it begins with the `profileUpdated` the harness itself commits. So
255 items meant **256 events**, and 511 meant 512: powers of two, not one short
of them, and 256 is exactly `DO_PAGE_SIZE`.

Worth keeping as a lesson rather than deleting: the "no literal 255 anywhere, so
it must be emergent" reasoning was sound, and it pointed hard in the wrong
direction because the *measurement* was wrong. It also counted the client
session's materialised rows, which lag the leader. Neither number should have
been load-bearing.

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

## Reproducing it — and the harness is still here

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

Under the old WebSocket configuration B pulled ~100 per batch, stopped at 255 or
511 `a-` rows (see above — that is 256 or 512 events), and never pushed its 600.
A stayed at 1000. Roughly seven minutes per run.

**This is the check to run against HTTP**, and it is the outstanding one: it is
the only tool here that reaches OPFS and the SharedWorker leader. Two things to
fix in it first. `count()` returns `total` as well as the `a-`/`b-` splits — use
`total`, since the prefix counts silently omit every event that is not an item.
And it counts the *client session's* rows, which lag the leader, so read
`state()` for the leader's heads rather than inferring progress from a row
count.

Note that the page ships in the production SPA at `/onboarding/harness`, and
`window.__h.commit` writes arbitrary events into the real store. That is
tolerable for a single-learner deployment and worth removing once the browser
check has been run.

## Also worth knowing

Cost is `O(pending × batches)`: every pulled batch rebases the *entire* pending
queue, so a device that has fallen further behind degrades quadratically. This
file used to call that "separate from the stall". It is not separate — it is the
**trigger**. The quadratic cost is what made a page take longer than the ten
seconds both failure modes needed, which is also why a device with ~1900 pending
events was hopeless. Changing transport removes the failure, not the cost: a
device that has been away a long time will still be slow to catch up. It will
now converge rather than stop.

## What is still not covered

- **No browser has synced through the new configuration.** The verification in
  `docs/livestore-sync.md` runs through the node adapter, which shares the leader
  thread but not OPFS or the SharedWorker leader — the half where every real bug
  in this feature has lived.
- **Two upstream faults are merely avoided, not fixed**, and would bite again if
  the transport ever changed back: an `Ack` for a forgotten request is silently
  discarded, and a transient socket error orphans an in-flight stream RPC
  because the client never re-issues it. Both are worth reporting upstream. The
  underlying design question is that the acknowledgement means "materialised"
  when it should mean "received".
