---
paths:
  - "src/lib/db/**"
  - "src/lib/srs/**"
  - "src/lib/types.ts"
  - "src/lib/validate/**"
---

# Domain types, SRS and persistence

- `src/lib/types.ts` — shared domain types. Treat as frozen; extend with **additive optional fields only**. Zod mirrors live per type — generated-side in `src/lib/llm/challenge-types/<type>.ts`, stored-side in `src/lib/challenges/types/<type>.ts` — and reach the app through the `src/lib/llm/schemas.ts` façade: generated-side fields are `.nullish()` (models emit `null`), stored-side `.optional()`; the resolver normalizes null→absent.

- `src/lib/srs/` — pure and deterministic: every function takes `now` (epoch ms); card state is a JSON-safe `FsrsCardState` (dates as numbers). Session pacing (new-word rate from recent accuracy) lives here.

- `src/lib/db/` — repositories are the **only** Dexie access. Every write passes through `toPlain()`, which strips Svelte `$state` Proxies (IndexedDB structured clone throws `DataCloneError` on them — never hand reactive objects to persistence). API key + prefs live in localStorage (`ll.*` keys via `db/settings.ts` and `ui/prefs.ts`), never in IndexedDB and never in the JSON export.
