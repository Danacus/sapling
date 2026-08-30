---
paths:
  - "src/lib/db/**"
  - "src/lib/srs/**"
  - "src/lib/types.ts"
  - "src/lib/validate/**"
---

# Domain types, SRS and persistence

- `src/lib/types.ts` — shared domain types. Treat as frozen; extend with **additive optional fields only**. Zod mirrors live per type — generated-side in `src/lib/llm/challenge-types/<type>.ts`, stored-side in `src/lib/challenges/types/<type>.ts` — and reach the app through the `src/lib/llm/schemas.ts` façade: generated-side fields are `.nullish()` (models emit `null`), stored-side `.optional()`; the resolver normalizes null→absent.

- `src/lib/srs/` — pure and deterministic: every function takes `now` (epoch ms); card state is a JSON-safe `FsrsCardState` (dates as numbers). `selectSessionItems` picks the words a generated batch is written about: due first (most overdue first, capped at `maxItems`), then topped up with the soonest-due items that are not due yet — generation introduces no vocabulary, so a learner who is caught up must still have something for the model to write about. `accuracyFromHistory` paces nothing any more; it is the prompt's difficulty dial.

- `src/lib/db/` — repositories are the **only** store access, and every write is an event. The `events` table is the log — the only thing sync moves — and everything else (`items`, `reviews`, `challenges`, `results`, `daily`, `tombstones`, `profile`) is an aggregate the materializer maintains; UI reads never touch `events` (or `reviews` in bulk — the FSRS card and counters live on the `items` row). Materializers apply once per event id — dedupe happens at the log — must be **total** (a rule that cannot apply returns, never throws), and resolve last-write-wins by `at`. Ids that cross devices derive from synced content, never from anything device-local. Every write passes through `toPlain()` first, which strips Svelte `$state` Proxies — the event payload crosses `postMessage` to the SQLite Worker, which throws `DataCloneError` on a bare Proxy, same as structured clone anywhere else. API key + prefs live in localStorage (`ll.*` keys via `db/settings.ts` and `ui/prefs.ts`), never in the store and never in the JSON export.
