---
paths:
  - "src/lib/db/**"
  - "src/lib/srs/**"
  - "src/lib/types.ts"
  - "src/lib/validate/**"
---

# Domain types, SRS and persistence

- `src/lib/types.ts` — shared domain types. Treat as frozen; extend with **additive optional fields only**. Zod mirrors live per type — generated-side in `src/lib/llm/challenge-types/<type>.ts`, stored-side in `src/lib/challenges/types/<type>.ts` — and reach the app through the `src/lib/llm/schemas.ts` façade: generated-side fields are `.nullish()` (models emit `null`), stored-side `.optional()`; the resolver normalizes null→absent.

- `src/lib/srs/` — pure and deterministic: every function takes `now` (epoch ms); card state is a JSON-safe `FsrsCardState` (dates as numbers). `selectSessionItems` picks the words a generated batch is written about: due first (most overdue first, capped at `maxItems`), then topped up with the soonest-due items that are not due yet — generation introduces no vocabulary, so a learner who is caught up must still have something for the model to write about. There is no trailing-accuracy dial: what a word's challenges look like follows from that word's own `wordStrength`, which FSRS already moves on every answer.

- **An event payload schema must name every optional field of the type it carries.** Zod *strips* what it is not told about, and `parseEvent` is the gate everything off sync or out of a backup file passes through — while a local `commit` does not parse at all. A field the schema forgets therefore works perfectly on the device that wrote it and vanishes on the device it arrives at, which is the worst shape a bug can have. `textAdded` is the one that has already been caught by this (`ReadingSentence.start`/`end` and `ReadingText.media`), and `merge.test.ts` pins it: the test is `parseEvent(raw)` equalling `raw`, field for field.

- `src/lib/db/` — repositories are the **only** store access, and every write is an event. The `events` table is the log — the only thing sync moves — and everything else (`items`, `reviews`, `challenges`, `results`, `daily`, `tombstones`, `profile`) is an aggregate the materializer maintains; UI reads never touch `events` (or `reviews` in bulk — the FSRS card and counters live on the `items` row). Materializers apply once per event id — dedupe happens at the log — must be **total** (a rule that cannot apply returns, never throws), and resolve last-write-wins by `at`. Ids that cross devices derive from synced content, never from anything device-local. Every write passes through `toPlain()` first, which strips Svelte `$state` Proxies — the event payload crosses `postMessage` to the SQLite Worker, which throws `DataCloneError` on a bare Proxy, same as structured clone anywhere else. API key + prefs live in localStorage (`ll.*` keys via `db/settings.ts` and `ui/prefs.ts`), never in the store and never in the JSON export.
