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

- **Sync is unsafe and should stay off (2026-08-29).** A device with more than ~100 unsynced events that reconnects to a server which has moved ahead **silently loses its own unsynced writes** — its own local state, nothing logged. Reproduced with every Sapling-specific part removed, including `worker/` itself (stock `makeWorker`, no rewrite, no auth), so it is an upstream LiveStore 0.4.0 defect, not ours. `docs/livestore-sync.md` has the reproduction and the isolation table. Do not re-enable, and do not "fix" it by guessing — two plausible fixes (`initialSyncOptions`, the error policies) were tested and made no difference.

- **There is a sync backend, and it is a sequencer.** `worker/` is a Cloudflare Worker over `@livestore/sync-cf`, one SQLite Durable Object per learner; `src/lib/sync/` is the client half. It orders and relays opaque events and never merges — every merge rule is here, in `materializers.ts`, resolving by position in the log. `docs/livestore-sync.md` is the architecture and the runbook. Two things it is easy to break: the client's `storeId` is the constant `'sapling'` and the *Worker* maps a pairing phrase to the room (deriving the local store's name from the phrase would rename its OPFS database and strand everything written before pairing), and `migrationState` must stay a `clientDocument` — a synced migration marker would make a learner's second device skip its own Dexie migration.
