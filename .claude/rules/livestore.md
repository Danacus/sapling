---
paths:
  - "src/lib/livestore/**"
---

# The LiveStore data layer

The eventlog is the source of truth; the SQLite tables are a projection of it. `docs/sync.md` is the *historical* design doc — it is where the merge rules were argued out and the code still cites it by section, but it describes a system that no longer exists. Read it for the reasoning, not for the architecture.

- **The split.** `events.ts` is the write model, `tables.ts` the read model, `materializers.ts` the rules that turn one into the other, `schema.ts` the assembly, `derive.ts` everything computed rather than stored (the FSRS card, `timesServed`/`lastServedAt`, the streak). `store.ts` owns the singleton and the boot sequence; `migrate-dexie.ts` + `$lib/db/legacy-snapshot.ts` carry a pre-LiveStore learner across.

- **Materializers must be total.** A materializer that throws does not skip its event — it shuts the store down permanently, and every later read fails with "Store has been shut down". A bare `insert` onto a duplicate primary key is enough to do it. Always `.onConflict(...)` or an early `return []`. This cost real debugging time; it is in `gotchas` too.

- **Order is the eventlog's, not a timestamp's.** LiveStore gives every client the same totally ordered log and rebases local events onto remote ones, so materializing in log order is deterministic across clients. Last-write-wins means *last in the log*, not latest `at`. Do not reintroduce timestamp comparison to arbitrate a merge: `at` is domain data (when the learner did the thing), never a merge input.

- **Ids that cross devices must derive from synced content**, never from anything device-local — no `localStorage` value, no autoincrement, no array index, no insertion order. Two devices describing the same data must describe it with the same names or the merge duplicates rather than dedupes. `migrate-dexie.ts` has the full audit table; the one that got this wrong was Dexie's `results.seq`.

- **`tombstones` is load-bearing.** A delete has to outrank an `item-added` that arrives later from a device with no shared causal history — a second device's migration is exactly that. Do not remove it on the argument that an add always precedes its own delete; that argument assumes one causal line. See the note in `materializers.ts`.

- **Effect `Schema.Struct` strips unknown keys on decode** — the opposite of the `z.looseObject` it replaced. Anything that must travel verbatim (challenge content) belongs in a JSON column typed `Schema.Any`, with any allow-list enforced in the materializer, where an unknown value costs one skipped row instead of a rejected event.

- **Tests run against a real store.** `store.testing.ts` gives a node-adapter store, so the data layer is exercised rather than mocked — WASM SQLite runs fine under vitest's node environment. Merge behaviour belongs in `merge.test.ts`, cross-device convergence in `two-device-migration.test.ts`.

- **The Dexie database is read-only and must stay migratable.** Never edit the `version(n).stores(...)` declarations in `$lib/db/database.ts` — they describe what is already on learners' disks, and changing one makes Dexie upgrade (and mutate) that data the moment the migration opens it. Never delete the learner's Dexie data either; until they have migrated it is their only copy.

- **There is no sync backend.** The app is single-device today. Adding one means a LiveStore sync provider (`@livestore/sync-cf` on Workers + Durable Objects, or the sync-backend interface against something else) — not a new homebrew relay.
