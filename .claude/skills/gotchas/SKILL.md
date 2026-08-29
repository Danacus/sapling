---
name: gotchas
description: >
  Sapling's log of pitfalls that already cost real debugging time. Load before
  touching TTS/sherpa/Kokoro, Cloudflare headers or redirects, the service
  worker, Dexie persistence, the nix flake or pnpm-workspace.yaml — and whenever
  a command or a "fix" fails in a way that doesn't make sense.
user-invocable: false
---

# Gotchas

Each entry is here because it already went wrong once. Append rather than
rewrite; a dated line about a real incident is worth more than a tidy rule.

## Persistence

- **`store.shutdown()` does not flush pending writes — settle first (2026-08-29).**
  Committing a batch of events and then immediately `await`ing
  `shutdownPromise()` silently drops whatever had not yet been written; the
  events never reach the eventlog at all. Upstream: livestore#416, open, no fix
  in 0.4.0. This is a *test-harness* trap above all, and it cost most of a day:
  a sync repro that committed 400 events and shut down at once persisted only
  ~101, which read exactly like the sync engine losing data on reconnect and
  produced a confident, wrong bug report against LiveStore. Sleep a few seconds
  after the last `commit` before shutting a store down, and prove any suspected
  loss by reopening the store **with no sync backend** and counting there — a
  count taken from a live, syncing store confuses "not yet materialised" with
  "gone".

- **No client-side signal means "the server has my events" (2026-08-29).** Two
  look like they do and neither does. `store.syncStatus().pendingCount` is
  *session-to-leader* and hits 0 the instant the leader accepts a commit — it
  says nothing about the network, which is exactly why the original sync stall
  showed `isSynced: true` throughout. The leader's own `pending.length` (via
  `_dev.syncStates()`) is 0 *before* the commits have crossed into it as well as
  after they have been pushed, so polling it passes instantly. `upstreamHead`
  is the honest one — it only advances on a confirmed push — but the truly safe
  probe is to boot a second store and see what it pulls. Related: with
  `livePull: false`, `createStorePromise` resolves *before* the boot pull
  finishes (`initialSyncOptions` defaults to `Skip`), so a reader counted right
  after `open()` reads zero. Both cost an hour of chasing a "broken" transport
  that was working the whole time.

- **Never hand a Svelte `$state` proxy to Dexie.** IndexedDB's structured clone
  throws `DataCloneError` on proxies. Every write goes through `toPlain()` in
  `$lib/db`, which strips them. Repositories are the only Dexie access.
- API key and prefs live in **localStorage** (`ll.*` keys, via `db/settings.ts`
  and `ui/prefs.ts`) — never in IndexedDB, and never in the JSON export.
- **A LiveStore materializer that throws kills the store permanently.** It does
  not skip the event: the exception propagates and every later `query` fails
  with "Store has been shut down". A bare `insert` of a duplicate primary key is
  enough. Materializers must be total — `.onConflict('id', 'ignore')` is what
  makes them so. Committing an event type the schema does not define does the
  same thing, from the client API side.

## TTS

- The int8 Kokoro variant is a **known upstream NaN/silence bug**. It is smaller
  and it is tempting. Don't "optimize" back to it; the fp32 artifacts (~439MB)
  are the working ones.
- `static/tts/sherpa-worker.js` is **plain JS outside Vite on purpose** — a
  bundled TS worker diverged between dev and build. Config reaches it via the
  init message from `sherpa.ts`; `models.ts` is the single source of truth for
  artifact URLs and sizes.
- Audio failures must degrade silently to fallback. Sound never blocks gameplay.

## Deploying / edge caching

- **2026-08-24 incident:** `/_app/immutable/*` must serve a real 404
  (`static/404.html`) on a miss, *not* fall through to the SPA shell. A single
  stale-client request for a dead hashed chunk gets edge-cached under the
  immutable header and poisons that URL for everyone for up to a year.
  `static/_redirects` encodes this — don't simplify it to a blanket fallback.
- **2026-08-29, a correction:** this file used to say cross-origin isolation
  breaks the TTS model-mirror fetches. It does not. Measured under
  `COOP: same-origin` + `COEP: require-corp`, the app boots with
  `crossOriginIsolated = true` and both sherpa artifacts still load 200. COEP
  imposes CORP on **no-cors** subresources only, and `sherpa-worker.js` uses a
  bare `fetch(url)` (mode `cors`) against a mirror sending
  `access-control-allow-origin: *`. `static/_headers` still sets no COOP/COEP —
  because nothing needs isolation, not because it is unavailable. Firefox only;
  re-check in Chrome before enabling. The wrong version of this note nearly cost
  a needless plan to self-host 439MB of Kokoro voices.
- **SvelteKit's `$service-worker` `build` list omits Vite worker output.** It is
  assembled purely from Vite's *client manifest*, and a `?worker` import is a
  separate Rollup build that never appears there. Anything loaded via `?worker`
  is served but never precached, so it works everywhere except offline, and only
  for users who already installed the PWA — `install` still succeeds, so nothing
  looks wrong. `kit.serviceWorker.files` cannot reach it either; it filters
  `static/` only.
- **A `?worker` graph emits its own copy of every shared asset.** SvelteKit gives
  it a separate asset directory *and* naming pattern (`workers/assets/[name]-[hash]`
  vs `assets/[name].[hash]`), so an asset both graphs need is downloaded and
  compiled twice. `vite.config.ts` realigns the patterns from a plugin ordered
  **after** `sveltekit()` — setting `worker.rollupOptions` at the top level is
  silently overridden by SvelteKit's own `config` hook.
- `pnpm-workspace.yaml` records pnpm's dependency build-script decisions
  (`allowBuilds`). An **undecided** script hard-fails Cloudflare Pages' CI
  install. Keep decisions explicit there.

## Toolchain

- **Nix flakes only see files that are `git add`ed.** A brand-new file the flake
  needs must be staged before direnv (or `nix develop`) picks it up. This looks
  exactly like "the flake is broken".
- `server/` is a separate package with its own `node_modules`. Its tests fail
  confusingly until `cd server && pnpm install` has run once.

## Content

- **Never romanize a term in isolation.** `romanize/zh.ts` puts the *whole*
  string through pinyin-pro and slices readings per character, because context
  is what resolves polyphones (银行 háng vs 自行车 xíng).
- Old challenges keep playing as they were generated. Prompt and schema changes
  reach the pool **only via newly generated batches** — the most common cause of
  a "the fix didn't work" report.

## Adding to this file

When a command, test or fix fails in a way that surprised you, add the entry
here in one or two lines: what looked wrong, and what was actually true.
