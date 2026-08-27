---
paths:
  - "src/lib/sync/**"
  - "server/**"
---

# Sync

The `sync-contract` skill carries the short list; `docs/sync.md` is the spec.

- `src/lib/sync/events.ts` + `server/` — multi-device sync, specced in **`docs/sync.md`** (read it before touching either side; the `sync-contract` skill has the short list). State is a fold over an append-only event log; the server stores and relays *opaque* events and merges nothing, so every semantic lives client-side. `events.ts` is the envelope schema shared verbatim by both, and is therefore **zod-only and import-free** — no `$lib`, no SvelteKit — because the server compiles it by relative path (`../../src/lib/sync/events.ts`). Per-type payload schemas stay client-side. The server's own contract is in `server/README.md`. `src/lib/sync/run.ts` exports `runSync()` — push, pull, apply, advance cursor; single-flight (overlapping callers share one cycle) and never throws, returning a `SyncOutcome` instead. Called from the Settings "Sync" card, fire-and-forget after `finish()`/`quit()` in `learn/+page.svelte`, and fire-and-forget once on boot in `+layout.svelte`.
