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

- **Never hand a Svelte `$state` proxy to Dexie.** IndexedDB's structured clone
  throws `DataCloneError` on proxies. Every write goes through `toPlain()` in
  `$lib/db`, which strips them. Repositories are the only Dexie access.
- API key and prefs live in **localStorage** (`ll.*` keys, via `db/settings.ts`
  and `ui/prefs.ts`) — never in IndexedDB, and never in the JSON export.

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
- `static/_headers` deliberately sets **no COOP/COEP**. Cross-origin isolation
  breaks the TTS model-mirror fetches.
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
