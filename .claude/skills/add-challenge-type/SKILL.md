---
name: add-challenge-type
description: >
  Add a new challenge type to Sapling, or add a new generation wire type.
  Use when asked to add, create, or scaffold a challenge type / question type /
  exercise type, a new wire type, or a new member of the challenge union
  (e.g. "add a listening-comprehension challenge", "add a new cloze variant").
argument-hint: [type-name]
---

# Adding a challenge type

Two different jobs live here. Pick the right one first:

- **Wire type only** — a new shape the model may *emit*, resolving into an
  existing stored type. Two edits. Nothing downstream changes.
- **Challenge type, end to end** — a new member of `ChallengeType`, with its own
  grading, presentation and component. Four registrations.

If the new question can be graded and drawn by an existing stored type, it is a
wire type. Only widen the stored union when grading or presentation genuinely
differs.

## Wire type only — two edits

1. Write one def module in `src/lib/llm/challenge-types/<type>.ts`, using
   `satisfies WireTypeDef<T>` (not a type annotation — an annotation widens the
   schema and defeats zod's inference). It bundles: zod `schema`, `promptSpec`
   (its `Types:` line), `correctiveSpec`, `resolve`, `fixtures` (one per mock
   scenario, with `order` set to the intended lesson position), and optional
   `rulesSpec` / `escalationSpec`.
2. Register it in the ordered `WIRE_TYPE_DEFS` in `challenge-types/index.ts`.

Import direction is strict: `primitives.ts` ← def modules ← `index.ts` ←
`schemas.ts` ← `generate.ts`. **A def module must never import `schemas.ts`.**

Registry order *is* prompt order *is* union order — inserting in the middle
changes the composed prompt. Prefer appending unless order matters.

## Challenge type, end to end — four registrations

Each omission is caught by a different gate. That is the design; lean on it
rather than checking by eye.

1. **Wire def** in `llm/challenge-types/index.ts` (as above).
   *Forget it:* the type does not exist at all — nothing prompts it, nothing
   parses it. A missing fixture fails `challenge-types/registry.test.ts`.
2. **Stored def** module in `src/lib/challenges/types/<type>.ts`, listed in
   `challenges/types/index.ts` **and** in `STORED_TYPE_ORDER`. It bundles the
   stored zod `schema`, the grading rule `check`, the difficulty tier `demand`,
   and the four presentation facts (`correctAnswerText`,
   `answerIsTargetLanguage`, `answerReading`, `spokenAnswerFor`).
   *Forget either:* `pnpm check` fails at the registry mapped type, or at the
   order-parity const.
3. **Component** in `src/routes/learn/`, composed from `blocks/`, plus a branch
   in `ChallengeHost.svelte`'s `{#if}` chain.
   *Forget it:* the `{:else}` `unhandledChallenge(challenge: never)` fails `pnpm check`.
4. **The `z.enum` in `src/lib/sync/events.ts`** — hand-maintained, because that
   file is import-free by contract.
   *Forget it:* `sync/events.test.ts`'s `{ [T in ChallengeType]: true }` table
   fails, and the type would not survive a sync.

## Rules that are easy to get wrong

- Stored def modules may import **zod, `$lib/types` and `$lib/validate` and
  nothing else** — asserted by `challenges/types/registry.test.ts`.
- `demand` is deliberately **not** consulted by `check`. Grading stays
  type-blind: a verdict is FSRS's evidence about the *word*, so difficulty
  shapes the question stream (`$lib/session/progression`), never what an answer
  is worth. Do not "improve" this by weighting grades.
- The component is logic plus composition. Anything that looks like a shared
  skin belongs in `blocks/`, not a scoped override — scoped overrides are how
  the six components drifted apart before.
- `ChallengeHost` is an `{#if}` chain on purpose; a component map loses the
  narrowing.
- Extend `src/lib/types.ts` with **additive optional fields only**.

## Completion criteria

- [ ] Every applicable registration above is done
- [ ] `pnpm check` passes — this is what catches registrations 2 and 3
- [ ] `pnpm test` passes — this is what catches registrations 1 and 4
- [ ] A fixture exists for each mock scenario, so the type is playable offline
- [ ] Played once in mock mode if the change is user-visible

Do not report done on a subset. Delegate the gates to the `verify` agent if you
want them off your context.

## Gotchas

- Prompt and schema changes **only reach the pool via newly generated batches**.
  Existing `ChallengeRow`s keep playing exactly as they were generated — a
  recurring source of "the fix didn't work" reports. Generate a fresh batch
  before judging the change.
