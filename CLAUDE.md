# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node and pnpm exist **only inside the Nix devShell**. Prefix every command with `nix develop -c` (or enter the shell once with `nix develop`).

```sh
nix develop -c pnpm dev                                # dev server
nix develop -c pnpm build                              # static build -> build/
nix develop -c pnpm check                              # svelte-check (typecheck)
nix develop -c pnpm test                               # vitest run (all suites)
nix develop -c pnpm test src/lib/srs/scheduler.test.ts # single test file
```

Nix flakes only see files that are `git add`ed — a brand-new file the flake needs must be staged before `nix develop` picks it up. `pnpm-workspace.yaml` is a comment-only placeholder pnpm recreates; leave it.

## Architecture

Local-first static SPA (SvelteKit 2 + Svelte 5, `adapter-static`, `ssr=false`), no backend. All user state lives in the browser. The one external call is a batched LLM request from the browser to OpenRouter with the user's own key.

**There is no `svelte.config.js`** — SvelteKit *and* vitest config live inline in `vite.config.ts`. **Runes mode is forced** project-wide: `$state`/`$derived`/`$effect`, `onclick` (not `on:click`).

### Token economy (the core design)

One batched LLM call (`src/lib/llm/generate.ts`) writes a whole lesson (~20 challenges, ~2.5k tokens) including everything needed to grade locally: exhaustive `acceptedAnswers`, distractors, romanization variants. Play-time grading is free (`src/lib/validate` fuzzy matching + `src/lib/srs` FSRS). The only mid-session spend is the user-initiated *Explain/dispute* escalation (`src/lib/llm/escalation.ts`), which can genuinely overturn a "wrong" grade via its structured `{answer, overturn}` reply. `match-pairs` challenges are assembled locally at zero cost. Mock mode (no API key, or `ll.mockMode`) routes deterministic fixtures through the *real* parse/resolve path — the whole app is developable without spending tokens, and node tests are always in mock mode.

**The model emits content, never presentation.** The generation wire format (`src/lib/llm/schemas.ts`) is five direction-specific types (`recognize-mc`, `produce-mc`, `cloze`, `translate-to-target`, `translate-to-native`) built on one primitive, `TargetText = {text, reading}` — target-language text carrying its own Latin reading, `reading: null` for Latin scripts. Every slot is unconditionally either a `TargetText` or a native string, so no field's language depends on a flag. `resolveBatch` then assembles the stored `Challenge`: it picks `direction` from the type, shuffles the options and computes `correctIndex` (injectable `rng`), joins `before + '___' + after` for cloze, and derives diacritic-folded `acceptedAnswers`. Whole bug classes — answer-spoiling romanizations, misaligned readings, correct-answer-always-in-slot-A — are unexpressible rather than guarded against.

The `SYSTEM_PROMPT` in `generate.ts` is deliberately token-budgeted and static (prompt-cache friendly). It carries load-bearing rule blocks (voice/anti-blandness, the one-line `TargetText` reading rule, answerability, difficulty calibration from `recentAccuracy`/`recentMistakes`). Prompt edits are the fix of first resort for content-quality bugs; `resolveBatch` degrades cosmetic defects silently (a partial reading is dropped, never the challenge) and drops only structural failures.

### Module contracts

- `src/lib/types.ts` — shared domain types. Treat as frozen; extend with **additive optional fields only**. Zod mirrors in `src/lib/llm/schemas.ts`: generated-side fields are `.nullish()` (models emit `null`), stored-side `.optional()`; the resolver normalizes null→absent.
- `src/lib/llm/` — **stateless**: data in, data out, never touches the DB. `getBatch` returns `newItems` with `fsrsCard: null`; the caller must initialize card state via `$lib/srs` before persisting. The OpenRouter client takes an injectable `fetch` — all LLM tests run against fakes, no network.
- `src/lib/srs/` — pure and deterministic: every function takes `now` (epoch ms); card state is a JSON-safe `FsrsCardState` (dates as numbers). Session pacing (new-word rate from recent accuracy) lives here.
- `src/lib/db/` — repositories are the **only** Dexie access. Every write passes through `toPlain()`, which strips Svelte `$state` Proxies (IndexedDB structured clone throws `DataCloneError` on them — never hand reactive objects to persistence). API key + prefs live in localStorage (`ll.*` keys via `db/settings.ts` and `ui/prefs.ts`), never in IndexedDB and never in the JSON export.
- `src/lib/session/engine.ts` — the orchestrator: owns session planning (`planSession` — pure, tested), generation (`generateChallenges` → `getBatch` → dedupe/remap → `addToPool`), all DB writes during play (`applyResult`, `applyOverturn`, `reportChallenge`), XP/combo rules and new-vocab dedupe/remap. Components emit answer events; they don't write.
- `src/lib/tts/` — public API `speak(text, lang)`; zh+en use Kokoro v1.1 via sherpa-onnx WASM, everything else Web Speech. **The worker is plain JS at `static/tts/sherpa-worker.js`, deliberately outside Vite** (a bundled TS worker diverged between dev and build); config reaches it via the init message from `sherpa.ts`, with `models.ts` the single source of truth for artifact URLs/sizes. Model files (~439MB fp32) are runtime-fetched from a pinned mirror commit and cached in Cache Storage; the int8 variant is a known upstream NaN/silence bug — don't "optimize" back to it. Audio failures must degrade silently to fallback; sound never blocks gameplay.

### Testing

Vitest, **node environment**, `src/**/*.test.ts` — pure logic only. No IndexedDB (no fake-indexeddb; Dexie code is covered by typecheck/build), no WASM, no network. DB-dependent engine logic is tested by mocking `$lib/db` per-file.

### Sessions & challenge lifecycle

**Generation and play are decoupled.** Every challenge ever generated lives in a persistent IndexedDB *pool* (`ChallengeRow` = `Challenge` + `generatedAt`/`timesServed`/`lastServedAt`/`reported`/`topic?`; Dexie `version(2)`, migrated from the v1 queue by the pure `poolRowFromLegacy`). Answering a challenge does not consume it — `applyResult` calls `recordServe`, which only stamps it. Serve-stamping at *answer* time is what makes an early quit self-cleaning: unplayed picks were never stamped, so they come back in the next plan for free.

`planSession(pool, items, now)` (pure, deterministic, tested) assembles a session: eligibility (not reported, all `itemIds` still resolve, never served or rested for `RESERVE_GAP` = 3 days), then **due-first** — each FSRS-due item, most overdue first, claims the best challenge covering it, and freshness only breaks ties and fills leftover slots. That ordering is load-bearing: a global freshness weight would let every new batch crowd out due reviews and quietly kill spaced repetition. `startSession()` reads pool + items and plans; session start never touches the network, so it is instant, always.

Generating is an explicit user action (`generateChallenges`, no threshold) that the learn screen runs **in the background** while a session can already be played from existing material; the new batch simply lands in the pool. So **prompt/schema changes only reach the pool via newly generated batches** — old rows keep playing as they were generated, which is a recurring source of "bug" reports. The learner can flag a bad challenge from the feedback banner; `reported` rows are excluded from `getPool()` forever.
