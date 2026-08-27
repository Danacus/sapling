---
name: sync-contract
description: >
  The rules governing Sapling's multi-device sync. Load before reading or
  editing anything under src/lib/sync/, the server/ package, the event envelope
  in sync/events.ts, or when a change adds a field that must survive a sync.
user-invocable: false
---

# Sync contract

**Read `docs/sync.md` before touching either side.** It is the spec; this is the
short list of things that break silently if you don't know them. The server's
own contract is `server/README.md`.

## The shape

State is a **fold over an append-only event log**. The server stores and relays
*opaque* events and merges nothing — every semantic lives client-side. If you
find yourself wanting the server to interpret a payload, the design has gone
wrong.

## Hard constraints

- `src/lib/sync/events.ts` is the envelope schema **shared verbatim by both
  sides**, and is therefore **zod-only and import-free** — no `$lib`, no
  SvelteKit, no `$lib/types`. The server compiles it by relative path
  (`../../src/lib/sync/events.ts`). One convenience import here breaks the
  server build, not the app's.
- Because of that, the `z.enum` of challenge types in `events.ts` is
  **hand-maintained**. `sync/events.test.ts` holds a
  `{ [T in ChallengeType]: true }` table that fails when it drifts. If that test
  fails, the fix is to add the missing member to the enum, never to loosen the test.
- Per-type payload schemas stay client-side.
- `runSync()` in `sync/run.ts` — push, pull, apply, advance cursor — is
  **single-flight** (overlapping callers share one cycle) and **never throws**,
  returning a `SyncOutcome`. Callers are fire-and-forget: the Settings "Sync"
  card, after `finish()`/`quit()` in `learn/+page.svelte`, and once on boot in
  `+layout.svelte`. Keep it non-throwing — the callers do not catch.
- The server is a **separate package, deliberately not a workspace member**, so
  the Cloudflare Pages build never sees it. Its commands run from the repo root
  as `cd server && pnpm …`, and it needs its own `pnpm install`.

## Verifying

Both sides have tests and they are separate suites:

- `pnpm test` (app side — `sync/events.test.ts`, `apply.test.ts`, `run.test.ts`,
  `genesis.test.ts`)
- `cd server && pnpm test && pnpm typecheck`

A sync change that only ran the app suite is not verified.
