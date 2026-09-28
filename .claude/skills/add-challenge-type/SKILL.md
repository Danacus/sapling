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
  existing stored type. Three edits. Nothing downstream changes.
- **Challenge type, end to end** — a new member of `ChallengeType`, with its own
  grading, presentation and component. Four registrations.

If the new question can be graded and drawn by an existing stored type, it is a
wire type. Only widen the stored union when grading or presentation genuinely
differs.

## Wire type only — three edits, all in `crates/sapling-llm`

1. **A data file, `lessons/<type>.json`**: `stored` (the `{type, direction}` —
   plus `promptIsTarget` where two types share that pair — the resolver always
   writes), `plannable` (`{demand, levels}`, omitted for a retired type),
   `promptSpec` (field list plus one inline example), optional `rulesSpec`,
   `paramsSpec`, `params` (each size key and its value at rungs 1..5),
   `correctiveSpec`, optional `escalationSpec`, and `fixtures` — at least one
   per scenario (`spanish`, `mandarin`), citing `{item}` for the want's word
   and `{other}` for a second one.

   **`params` is this type's difficulty**, as counts the model can hit
   (`words`, `tiles`, `gaps`): the same keys at every rung, monotone, aligned
   with the stored side's scales (`challenges/types/primitives.ts`'
   `lengthKnob`). A bank or tray size is **not** a rung-varying key: every
   banked type asks for its fullest set, and `$lib/challenges/serve/presentation`
   sizes what a served row shows. `paramsSpec` names exactly those keys.
   *Get either wrong:* `kinds.rs`' tests fail.

   `rulesSpec` holds **any** rule about this type — including one another
   type also needs, spelled out in both (segmentation is in `word-order` and
   `spot-error`). Only rules that name no type belong in `prompts/lesson.txt`.
2. **A `WireType` variant in `kinds.rs`** — in `ALL` (registry order: the
   planner's tie-break order and the escalation gloss order; appending keeps
   seeded picks stable), `as_str` and `source`. *Forget `ALL`:* the const
   assert under it fails the build.
3. **A wire struct and a `Generated` variant in `wire.rs`**, with its resolver
   arm in `resolve`. `serde` + `schemars` derives are the schema: array
   lengths as `#[schemars(length(...))]`, optional fields `Option`. The resolver
   drops a challenge only for a structural defect, and trims cosmetic ones.
   *Forget it:* every exhaustive `match` over `WireType` fails to compile.

`CHALLENGE_KINDS` in the generated `llm.ts` carries `stored` and `plannable` to
TypeScript, so `$lib/llm`'s `PLANNABLE_KINDS` and `kindOf` follow with no edit.
`src/lib/llm/index.test.ts` resolves every kind through wasm and checks the
result against the stored `challengeSchema`, `kindOf` and the stated `demand`.

## Challenge type, end to end — four registrations

Each omission is caught by a different gate. That is the design; lean on it
rather than checking by eye.

1. **Wire type** in `crates/sapling-llm` (as above).
   *Forget it:* the type does not exist at all — nothing prompts it, nothing
   parses it.
2. **Stored def** module in `src/lib/challenges/types/<type>.ts`, listed in
   `challenges/types/index.ts` **and** in `STORED_TYPE_ORDER`. It bundles the
   stored zod `schema`, the grading rule `check`, the difficulty tier `demand`,
   the within-tier `difficulty` (a `base` offset for how much the *format*
   asks, plus its structural knobs on the shared `lengthKnob` scale — see
   `types/primitives.ts`), and the five presentation facts
   (`correctAnswerText`, `answerIsTargetLanguage`, `answerReading`,
   `spokenAnswerFor`, `audioTexts`).
   *Forget either:* `pnpm check` fails at the registry mapped type, or at the
   order-parity const.
3. **Component** in `src/routes/learn/`, composed from `blocks/`, plus a branch
   in `ChallengeHost.svelte`'s `{#if}` chain.
   *Forget it:* the `{:else}` `unhandledChallenge(challenge: never)` fails `pnpm check`.
4. **`CHALLENGE_TYPES` in `crates/sapling-db/src/materialize.rs`** — the
   allow-list the pool materializer checks before storing a challenge. It is a
   Rust array of wire names, so nothing in `pnpm check` notices a missing one.
   *Forget it:* silent — challenges of the new type are written to the log and
   then skipped on the way into the pool, so the learner never sees one. Add a
   pooled challenge of the new type to the `broad` golden fixture
   (`src/lib/db/fixtures/broad/events.json`), rebless with `pnpm golden:update`,
   and check the diff shows it in `getPool`; that is the gate.

## Rules that are easy to get wrong

- Stored def modules may import **zod, `$lib/types`, `$lib/validate` and the
  three shared siblings (`./def`, `./primitives`, `./word-count`) and nothing
  else** — an explicit allowlist in `challenges/types/registry.test.ts`, so one
  def importing another def is caught too.
- `demand` is deliberately **not** consulted by `check`. Grading stays
  type-blind: a verdict is FSRS's evidence about the *word*, so difficulty
  shapes the question stream (`$lib/challenges/serve/progression`), never what an answer
  is worth. Do not "improve" this by weighting grades.
- The component is logic plus composition. Anything that looks like a shared
  skin belongs in `blocks/`, not a scoped override — scoped overrides are how
  the six components drifted apart before.
- `ChallengeHost` is an `{#if}` chain on purpose; a component map loses the
  narrowing.
- Extend `src/lib/types.ts` with **additive optional fields only**. The
  challenge union stays hand-written there: Rust stores a challenge as opaque
  JSON, so nothing about it is generated and `pnpm core:types` is not involved.

## Completion criteria

- [ ] Every applicable registration above is done
- [ ] `pnpm check` passes — this is what catches registrations 2 and 3
- [ ] `pnpm test` and `pnpm core:test` pass — this is what catches registrations 1 and 4
- [ ] A fixture exists for each mock scenario, so the type is playable offline
- [ ] Played once in mock mode if the change is user-visible

Do not report done on a subset. Delegate the gates to the `verify` agent if you
want them off your context.

## Gotchas

- Prompt and schema changes **only reach the pool via newly generated batches**.
  Existing `ChallengeRow`s keep playing exactly as they were generated — a
  recurring source of "the fix didn't work" reports. Generate a fresh batch
  before judging the change.
