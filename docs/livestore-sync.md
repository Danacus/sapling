# Bringing sync back — the brief for the next session

Status: **not started.** The app is single-device. This is the handoff for the
work that changes that.

Read `.claude/rules/livestore.md` first for how the data layer works, and
`docs/sync.md` for why each merge rule is what it is. This file only covers
what neither does: what a sync backend has to honour here, and what is still
unverified.

## Where things stand

The migration landed across two branches, neither merged. **Nothing is
deployed, and nothing should be** — Cloudflare Pages deploys on push to the
default branch, and the deliberate decision was not to ship a build with no
sync at all, since the old system did have it.

| Branch | Contains |
|---|---|
| `spike/livestore` | Steps 1–4b: the app runs on LiveStore, and a Dexie learner's library migrates across. |
| `livestore/retire-sync` | Step 5 on top: `src/lib/sync/` and `server/` deleted. |

So merging depends on this work existing. That is the whole reason it is next.

## What the backend actually has to do

Very little, and that is the point — it is why this migration was worth doing.
It accepts pushed events, assigns them a **global total order**, and relays
them on pull. It never merges and never interprets a payload.

The old `server/` already implemented exactly that contract: opaque events, a
monotonic `seq`, no semantics. It was deleted rather than adapted because
LiveStore ships providers, not because it was wrong.

Three routes, in the order I would try them:

1. **`@livestore/sync-cf`** on Workers + Durable Objects. SQLite-backed DOs run
   on the free Workers plan and free-plan storage is not billed. Least work.
2. **The sync-backend interface** against something self-hosted, if
   self-hosting matters again. `@livestore/common/src/sync/sync-backend.ts` is
   the shape; `sync-backend-kv.ts` shows how small a KV-shaped one is.
3. **S2 or ElectricSQL**, both supported providers.

Nothing about the client changes between them.

## What the backend must not break

- **It is the sequencer, and the merge semantics depend on that.** Every
  last-write-wins rule here resolves by *position in the log*, not by `at`. A
  backend that reorders, deduplicates, or rewrites events changes application
  behaviour even though it never reads a payload.
- **`storeId` scopes a log.** One learner is one store. Getting this wrong
  merges two people's libraries.
- **Two devices migrating from Dexie is a solved problem — keep it solved.**
  `two-device-migration.test.ts` asserts convergence, and both halves of it
  were confirmed to fail when their fix is reverted. If sync work touches
  identity or ordering, that suite is the regression net.

## Open items, roughly by value

- **`unknownEventHandling` has never been exercised.** It is configured
  (`schema.ts`, `strategy: 'ignore'`) and asserted as configuration, but the
  behaviour — an older client meeting an event a newer one introduced —
  requires a second client syncing in. `@livestore/common` ships
  `mock-sync-backend.ts`, so **this is now reachable from a node unit test**
  and no longer needs two real devices. Worth doing early: it is the forward
  compatibility story for every future event type.
- **`profileImported` vs. `profileUpdated`.** The migration uses an
  insert-if-absent variant so a late-migrating second device cannot revert
  profile edits. Ordinary edits still use `profileUpdated`, which is
  last-in-the-log-wins. That is correct but untested against a real backend.
- **Not verified anywhere:** Chromium and Safari/iOS. Everything browser-side
  was checked in Firefox only. iOS is the most likely to differ, since OPFS
  and worker behaviour there are the least like the others.
- **An interrupted migration** has never been staged. Deterministic ids make
  the redo safe in principle; nobody has killed a tab mid-commit to confirm.
- **`ll.syncDevice`** is a misleading key name for a value that no longer has
  anything to do with sync. It is half of a review's identity, so renaming it
  would mint a new device id and orphan every migrated review. Leave it.

## Two things worth doing regardless of sync

Both were raised and deferred as orthogonal:

- **There is no CI.** No `.github/workflows`, no git hooks. Cloudflare runs
  `pnpm build`, which does not typecheck and does not run tests, so a failing
  test or a type error can reach production. A workflow running
  `pnpm check`/`test`/`format:check` would close that.
- **The browser checks are not in the repo.** Every runtime claim in this
  migration — the store booting from OPFS, data surviving a reload, the app
  working with the server killed, a legacy database migrating — was proved by
  a throwaway puppeteer + Firefox harness that no longer exists. For a
  local-first app whose riskiest properties are all runtime ones, promoting a
  smoke test into the repo would be worth more than most unit tests.
