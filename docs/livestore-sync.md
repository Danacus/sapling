# Sync — the architecture, and how to stand it up

> ## ⚠️ Sync is unsafe as of 2026-08-29 — turn it off
>
> A device that accumulates more than ~100 unsynced events and then reconnects
> to a server that has moved ahead **silently loses its own unsynced writes**.
> Not "fails to sync" — *loses*. In the reproduction below a client holding 400
> of its own events ends with 101, in its own local database, with nothing
> logged at any level.
>
> This is **not** Sapling's bug. It reproduces with every Sapling-specific
> ingredient removed (see "The divergence data-loss bug"). Do not re-enable sync
> until it is resolved upstream or a guard is in place.

Status: **deployed, 2026-08-29.** The Worker is live at
`https://sapling-sync.vanoverloop.xyz` and answers on `/`. No learner has yet
synced two real *browsers* through it — the convergence check below ran through
the node adapter, which shares LiveStore's leader thread but not the
OPFS/SharedWorker path.

**The app only offers sync if `VITE_SYNC_URL` was set when it was built.** It is
inlined at build time (`src/lib/sync/url.ts`), so setting it in the Pages
environment does nothing to deployments that already exist — Settings will keep
saying "this build has no sync backend" until a *new* build runs. Set the
variable for the Production environment, then redeploy (retry the deployment or
push a commit).

Read `.claude/rules/livestore.md` first for how the data layer works, and
`docs/sync.md` for why each merge rule is what it is. This file covers what
neither does: what the backend is, the two decisions that shaped it, and what is
still unverified.

## What the backend does

Very little, and that is the point — it is why the LiveStore migration was worth
doing. It accepts pushed events, assigns them a **global total order**, and
relays them on pull. It never merges and never interprets a payload.

`worker/index.ts` is a Cloudflare Worker over `@livestore/sync-cf`, with one
SQLite-backed Durable Object per learner. Free-plan Workers run SQLite DOs and
free-plan storage is not billed. WebSocket is the only transport enabled: it is
what a browser uses, and it hibernates between messages, so an idle learner
costs no CPU.

Only two things are ours rather than stock `makeWorker`, and both are worth
understanding before changing anything here.

### 1. The room is named by the phrase, not by the client's `storeId`

There are no accounts. A learner's identity is a 100-bit **pairing phrase**
(`src/lib/sync/phrase.ts`), minted on the device that turns sync on and typed
into any device that joins. The Worker hashes it — `SHA-256('sapling:sync:v1:' +
phrase)` — and uses the digest as the Durable Object's name, so possession of
the phrase *is* the authorisation and the check is entirely stateless. There is
no user table to keep in sync, and nothing to attack offline: a guess is an
online guess against Cloudflare.

Every client sends `storeId: 'sapling'`, and the Worker rewrites it. **That
rewrite is the load-bearing part.** The obvious design — derive the store's
*local* name from the phrase — is a trap: `storeId` names the database in OPFS,
so a device that paired would rename its store, which is to say open a new empty
one and strand everything written before pairing in the old. Local identity and
remote identity are kept separate, nothing on disk ever moves, and pairing
changes only which room events are relayed through.

The phrase travels in the connection's query string, because
`@livestore/sync-cf` puts the sync payload there and a browser cannot set
headers on a WebSocket. TLS covers it in transit; it may still appear in request
logs. That is why the room is named by a hash rather than by the phrase itself,
and it is the strongest argument left for `docs/sync.md` §10's end-to-end
encryption if this ever serves more than one person's own devices.

### 2. Sync is opt-in, and "off" is a real backend

`SYNC_URL` (build-time, `VITE_SYNC_URL`) decides whether this build can sync at
all; the learner's switch decides whether it does. The switch reaches the
LiveStore leader worker as the *presence of a sync payload*, because a Web
Worker has no `localStorage` to consult — and when it is absent,
`src/lib/sync/offline-backend.ts` supplies a backend that reports offline
forever. Read the comment in that file before replacing it with something
simpler: a backend whose `push` quietly succeeds would have LiveStore mark
events as confirmed by a server that has never seen them, and the day sync was
switched on the client would arrive with a cursor describing a log that does not
exist.

## Standing it up

```sh
npx wrangler login                 # once, per machine
pnpm sync:deploy                   # creates the Worker + its Durable Object
```

Deploy it by hand once, to create the Worker and learn its URL. After that you
can put it on **Workers Builds** — the Workers equivalent of the Pages git
integration — and it deploys on push like the app does: in the dashboard, the
Worker → Settings → Builds → Connect, deploy command `npx wrangler deploy`,
production branch `main`. Nothing about that lives in the repo, which is why it
is written down here. Note the ordering on first go-live: the app's build needs
`VITE_SYNC_URL` *already set* in the Pages environment, so set it before the
push that turns sync on. The deployment uses a custom domain,
`https://sapling-sync.vanoverloop.xyz`, bound to the Worker in the Cloudflare
dashboard; `wrangler deploy` alone would put it on
`sapling-sync.<subdomain>.workers.dev`, which also works if the custom domain is
ever in doubt.

**If you add build watch paths, include `src/lib/sync/*`.** The Worker imports
`phrase.ts` from the client deliberately, so watch paths scoped to `worker/*`
alone would deploy a new client against a stale Worker — and two normalisations
that disagree compute two different rooms, which surfaces as an empty library
rather than as an error. Empty watch paths (rebuild everything on every push) is
the safe default.

Then point the app at it and rebuild:

```sh
cp .env.example .env               # set VITE_SYNC_URL to the deployed URL
```

For Cloudflare Pages, set `VITE_SYNC_URL` in the Pages project's build
environment — the app and the Worker are deployed separately on purpose (see
`.claude/rules/deploy.md`).

Locally, `pnpm sync:dev` serves the Worker at `http://localhost:8787`; set
`VITE_SYNC_URL=http://localhost:8787` in `.env` and `pnpm dev` will use it.

**Lock the deployment to your own phrases.** Unset, any well-formed phrase opens
a room — fine for a URL nobody knows, wrong for one that leaks:

```sh
npx wrangler secret put SYNC_ALLOWED_PHRASES   # comma-separated, canonical form
```

The value is the learner's own phrase — the Worker runs each entry through the
same `normalizePhrase` as the client, so dashes and case do not matter. Mint one
*before* first run rather than reading it out of the app afterwards, and there
is never a window in which the deployment accepts anything:

```sh
node -e "const A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';console.log([...crypto.getRandomValues(new Uint8Array(20))].map(b=>A[b%32]).join(''))"
```

Then enter it on each device through Settings → Sync → *Pair with another
device*, rather than using the switch, which would mint a different one. If the
phrase ever changes, the secret has to change with it — otherwise the learner
locks their own devices out.

For `pnpm sync:dev`, the same value goes in `.dev.vars`
(`SYNC_ALLOWED_PHRASES=...`), which is gitignored.

## Checking it actually works

The unit suite is offline by design, so the live path is checked by hand. This
took ten minutes and found a real bug (below); it is written down because the
last round of runtime checks was a throwaway harness that no longer exists.

Start the backend with `pnpm sync:dev`, then:

```sh
B=http://localhost:8787
P='%7B%22phrase%22%3A%22ABCDEFGHJKMNPQRSTVWX%22%7D'      # {"phrase":"ABCDE…"}
curl -s $B/                                              # 200, "Sapling sync backend."
curl -so/dev/null -w'%{http_code}\n' $B/nope             # 404
curl -so/dev/null -w'%{http_code}\n' "$B/?storeId=sapling&transport=ws"            # 401
curl -so/dev/null -w'%{http_code}\n' "$B/?storeId=sapling&transport=ws&payload=$P" # 426
```

`426` is the pass: it means the phrase was accepted and the request reached the
Durable Object, which then asked for a WebSocket upgrade.

For convergence, a temporary vitest file under `src/` (so `$lib` resolves) that
builds two `@livestore/adapter-node` stores with
`sync: { backend: makeWsSync({ url: 'http://localhost:8787' }), onSyncError: 'shutdown' }`,
`storeId: 'sapling'`, differing `clientId`s and `syncPayload: { phrase }`. Commit
an `itemAdded` on one and poll `tables.items.select()` on the other. **Verified
2026-08-29:** events cross in both directions, and a third store opened with a
*different* phrase sees nothing — the rooms are isolated. Delete the file
afterwards; the committed suite must stay network-free.

`onSyncError: 'shutdown'` is what makes that check worth anything. The app ships
with `'ignore'`, which would swallow exactly the failures being looked for.

## What the backend must not break

- **It is the sequencer, and the merge semantics depend on that.** Every
  last-write-wins rule here resolves by *position in the log*, not by `at`. A
  backend that reorders, deduplicates or rewrites events changes application
  behaviour even though it never reads a payload.
- **A room scopes a log.** One learner is one phrase is one Durable Object.
  Getting this wrong merges two people's libraries.
- **The Dexie migration marker must stay client-only.** `tables.migrationState`
  is a `clientDocument`, whose `set` event carries `clientOnly: true` and never
  syncs. If it ever synced, a learner's second device would receive "already
  migrated" and skip its own migration, losing everything it knew from before
  the upgrade. There is a note on the table saying so; this is the second place
  it is written down because it is the failure sync makes possible.
- **Two devices migrating from Dexie is a solved problem — keep it solved.**
  `two-device-migration.test.ts` asserts convergence, and both halves of it were
  confirmed to fail when their fix is reverted. If sync work touches identity or
  ordering, that suite is the regression net.
- **Room derivation is pinned by a test.** `worker/room.test.ts` asserts a
  literal digest. A change that made a phrase hash differently would not fail
  loudly — it would move every learner into a fresh empty room, which reads as
  lost data.

## The divergence data-loss bug (open, upstream)

Found 2026-08-29 while debugging a second device that would not sync.

**Signature.** Client B holds N unsynced events. Server has advanced beyond B's
last known head. B connects, pulls the server's events successfully, pushes
**exactly one batch (~100, `MAX_PUSH_EVENTS_PER_REQUEST`)**, and stops. B's
remaining N-100 events are then gone from *B's own local state*, not merely
unpushed. No error is logged — not at the client, not in the Durable Object.
With N=400 the result is reliably `own=101`.

**It is not ours.** Each ingredient was removed in turn and the failure
survived every time:

| Removed | Still loses data |
|---|---|
| The Dexie migration (plain `itemAdded` events) | yes |
| `offline-backend.ts` (LiveStore's own no-`sync` path) | yes |
| Large payloads (`challengeAdded` with ~12KB content) | yes |
| `onSyncError` / `onBackendIdMismatch` overrides (library defaults) | yes |
| `worker/index.ts` entirely — stock `makeWorker`, no storeId rewrite, no auth, local `wrangler dev` | yes |

So it is a defect in LiveStore 0.4.0's reconciliation (or `@livestore/sync-cf`),
not in this repo. It wants a minimal upstream report.

**Reproducing it.** Two `@livestore/adapter-node` stores on `fs` storage against
any sync backend. A commits 400 events and pushes. B is opened with *no* `sync`
option, commits 400 events, and is shut down. B is reopened *with* the sync
backend. Count items by id prefix: B settles at `own=101 remote=400` instead of
`own=400 remote=400`, and A agrees at 501 — so the events are not merely
unpushed, they are gone. Roughly two minutes per run; needs network, so it
cannot live in `pnpm test`.

**A boundary worth knowing.** An earlier run with a 100-event backlog converged
correctly; 400 and 1500 both fail. The threshold sits at about one push batch,
which is consistent with the push sequence failing to continue after the first
batch moves the head.

**What made it invisible.** `onSyncError: 'ignore'` is the right policy for
staying usable offline, and it is also what turns a recoverable condition into
permanent silence. Worse, the Settings connection check only proves the endpoint
is reachable and the phrase accepted — it reported "Connected" throughout, while
a device sat parked. Any future work here should surface the store's own sync
state (pending count, last confirmed head), not a ping.

## Open items, roughly by value

- **Nothing has been run against Cloudflare's actual edge.** Two stores
  converging, and a third with a different phrase seeing nothing, were both
  observed against a live Durable Object under `wrangler dev` (see above), and
  `wrangler deploy --dry-run` builds the Worker with its binding. Nobody has
  deployed it, and no *browser* has synced: the client half was exercised
  through the node adapter, which shares the leader-thread code but not the
  OPFS/SharedWorker path.
- **The offline backend cost a bug already, and the lesson generalises.** A
  `pull` that fails rather than never emitting hangs store creation, so the app
  does not boot at all. Nothing in the types says so.
  `src/lib/sync/offline-backend.test.ts` is the regression net; the shape of the
  failure — a plausible-looking sync backend that silently prevents boot — is
  worth remembering before hand-writing another one.
- **`unknownEventHandling` has never been exercised.** It is configured
  (`schema.ts`, `strategy: 'ignore'`) and asserted as configuration, but the
  behaviour — an older client meeting an event a newer one introduced —
  requires a second client syncing in. `@livestore/common` ships
  `mock-sync-backend.ts`, so this is reachable from a node unit test without
  two real devices. It is the forward-compatibility story for every future
  event type.
- **`onBackendIdMismatch: 'ignore'`** overrides a default of `'reset'`, which
  clears the local eventlog and state databases. The default is written for
  development, where client data is disposable; here the local store is the
  learner's only copy. The consequence is that a client which meets a reset
  backend keeps its data and silently stops converging. Nobody has staged that,
  and there is no UI that would show it.
- **`profileImported` vs. `profileUpdated`.** The migration uses an
  insert-if-absent variant so a late-migrating second device cannot revert
  profile edits. Ordinary edits still use `profileUpdated`, which is
  last-in-the-log-wins. That is correct but untested against a real backend.
- **Re-pairing to a different phrase is warned about, not handled.** The
  Settings page confirms before adopting a phrase that replaces an existing one,
  and says what it costs. What actually happens to a store that then pulls an
  unrelated log has not been observed.
- **Not verified anywhere:** Chromium and Safari/iOS. Everything browser-side
  was checked in Firefox only, and before sync existed. iOS is the most likely
  to differ, since OPFS and worker behaviour there are the least like the
  others.
- **`ll.syncDevice`** is a misleading key name for a value that has nothing to
  do with sync. It is half of a review's identity, so renaming it would mint a
  new device id and orphan every migrated review. Leave it.

## Two things still worth doing regardless

Both were raised and deferred as orthogonal, and both remain true:

- **There is no CI.** No `.github/workflows`, no git hooks. Cloudflare runs
  `pnpm build`, which does not typecheck and does not run tests, so a failing
  test or a type error can reach production. A workflow running
  `pnpm check`/`test`/`format:check` would close that.
- **The browser checks are not in the repo.** Every runtime claim in the
  LiveStore migration was proved by a throwaway puppeteer + Firefox harness that
  no longer exists. For a local-first app whose riskiest properties are all
  runtime ones — and which now has a network partner — promoting a smoke test
  into the repo would be worth more than most unit tests.
