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

## Wire type only — three edits

1. Write one def module in `src/lib/llm/challenge-types/<type>.ts`, using
   `satisfies WireTypeDef<T>` (not a type annotation — an annotation widens the
   schema and defeats zod's inference). It bundles: zod `schema`, `stored`,
   `promptSpec` (its field list plus one inline example), `params` +
   `paramsSpec`, `correctiveSpec`, `resolve`, `fixtures` (one per mock scenario,
   with `order` set to the intended lesson position), and optional `rulesSpec` /
   `escalationSpec`.
   `stored` is the `{type, direction}` this def's `resolve` always writes —
   `generate.ts` checks a request's reply against the brief it asked for by
   comparing it. *Forget it:* `pnpm check` fails at the def. *Get it wrong:*
   `registry.test.ts` resolves every fixture and compares, and the type would
   otherwise be asked for and then rejected on arrival, every time.

   **`params(difficulty, kind)` is this type's difficulty**, as counts the model
   can hit: `{words}`, `{tiles, distractors}`, `{words, bank}`. It must be pure,
   keep the same keys at every rung, and be monotone in the rung (lengths never
   fall; a word bank shrinks, since a bank is support). Align the ends with the
   *stored* side's scales — `challenges/types/primitives.ts`' 1..12-word
   `lengthKnob`, and whatever constants that type's stored `difficulty` reads —
   so a challenge written at rung 1 sits at the low end of its tier and one at
   rung 5 at the high end. `paramsSpec` is one prompt line explaining exactly
   the keys `params` returns, in the model's terms.
   *Forget either, or emit a key `paramsSpec` does not name:* `registry.test.ts`
   fails (and `pnpm check` fails at the def for a missing one).

   Its `rulesSpec` is where **any** rule about this type goes — including one
   another type also needs, spelled out in full in both (segmentation is in
   `word-order` *and* `spot-error`). A duplicated line costs nothing it did not
   already cost: each copy only ever travels on its own type's calls. It states
   **no difficulty gradient** — `params` is the difficulty — only the judgement
   no number expresses (how close a distractor should sit, how subtle a planted
   error should be). Only rules that name no type at all belong in
   `generate.ts`'s shared preamble.
2. Register it in the ordered `WIRE_TYPE_DEFS` in `challenge-types/index.ts`.
3. **Add a `SlotKind` for it in `src/lib/llm/slots.ts`** — to
   `RECOGNITION_KINDS` if the answer is visible on screen, to
   `YOUNG_PRODUCTION_KINDS` / `SOLID_PRODUCTION_KINDS` if the learner has to
   produce it, choosing the maturity at which it becomes fair to ask. Match the
   tier to the *stored* `demand` its resolved challenge reports: a type planned
   as recognition but stored as demand 1 is written for words the session
   planner will then refuse to serve it to.
   *Forget it:* the type is described to the model, exampled, and **never asked
   for** — the app chooses types now, not the model. `registry.test.ts` fails on
   the `PLANNABLE_KINDS` parity check.

Import direction is strict: `primitives.ts` ← def modules ← `index.ts` ←
`schemas.ts` ← `generate.ts`, with `slots.ts` importing only types back from
`generate.ts`. **A def module must never import `schemas.ts`**, and never
`slots.ts` either — a def sizes itself by `DifficultyRung` and `SizingKind`,
which `def.ts` declares for exactly that reason.

Registry order *is* union order and escalation-gloss order — but no longer
prompt order, since each type composes its own prompt. Prefer appending.

## Challenge type, end to end — four registrations

Each omission is caught by a different gate. That is the design; lean on it
rather than checking by eye.

1. **Wire def** in `llm/challenge-types/index.ts` (as above).
   *Forget it:* the type does not exist at all — nothing prompts it, nothing
   parses it. A missing fixture fails `challenge-types/registry.test.ts`.
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
4. **`CHALLENGE_TYPE_TABLE` in `src/lib/db/materialize.ts`** — the
   allow-list the pool materializer checks before storing a challenge.
   *Forget it:* `pnpm check` fails at the `Record<ChallengeType, true>` literal.
   Without that typing it would instead be silent — challenges of the new type
   would be written to the log and then skipped on the way into the pool.

## Rules that are easy to get wrong

- Stored def modules may import **zod, `$lib/types`, `$lib/validate` and the
  three shared siblings (`./def`, `./primitives`, `./word-count`) and nothing
  else** — an explicit allowlist in `challenges/types/registry.test.ts`, so one
  def importing another def is caught too.
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
