---
name: gotchas
description: >
  Sapling's log of pitfalls that already cost real debugging time. Load before
  touching TTS/sherpa/Kokoro, Cloudflare headers or redirects, the service
  worker, SQLite/OPFS persistence, the nix flake or pnpm-workspace.yaml — and
  whenever a command or a "fix" fails in a way that doesn't make sense.
user-invocable: false
---

# Gotchas

Each entry is here because it already went wrong once. Append rather than
rewrite; a dated line about a real incident is worth more than a tidy rule.

## Persistence

- **Never hand a Svelte `$state` proxy to an event payload.** IndexedDB and
  Dexie are gone, but the reason for `toPlain()` survived them: the payload
  crosses `postMessage` to the SQLite Worker, which uses structured clone and
  throws `DataCloneError` on a bare Proxy just the same. Every write goes
  through `toPlain()` in `$lib/db`, which strips them. Repositories are the
  only store access.
- API key and prefs live in **localStorage** (`ll.*` keys, via `db/settings.ts`
  and `ui/prefs.ts`) — never in the store, and never in the JSON export.
- **The SQLite SAH-pool VFS is exclusive.** Only one tab can hold `/sapling.db`
  at a time; a second tab's boot fails with "Sapling is already open in another
  tab." — close the other tab and reload. There is no leader election.

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
  compiled twice. This only bites when the *same* asset is needed on both sides
  of a `?worker` boundary — the sqlite-wasm binary today is loaded only inside
  `sqlite.worker.ts`, not on the window thread, so there is nothing to dedupe
  and `vite.config.ts` carries no plugin for it. If a future asset needs both
  sides again, realign the patterns from a plugin ordered **after** `sveltekit()`
  — setting `worker.rollupOptions` at the top level is silently overridden by
  SvelteKit's own `config` hook.
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
