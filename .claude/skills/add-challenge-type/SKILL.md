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
  existing stored type. Nothing downstream changes.
- **Challenge type, end to end** — a new member of the stored union, with its
  own grading, presentation and component.

If the new question can be graded and drawn by an existing stored type, it is a
wire type. Only widen the stored union when grading or presentation genuinely
differs.

## Wire type only

1. **The kind, in `crates/sapling-challenges`**: a `WireType` variant in
   `kinds.rs` — in `ALL` (registry order: the planner's tie-break order and the
   escalation gloss order; appending keeps seeded picks stable) and `as_str` —
   and its entry in `data/kinds.json`, in the same order: `stored` (the
   `{type, direction}` the resolver always writes, plus `promptIsTarget` where
   two kinds share that pair) and `lengths` (`[shortest, longest]` a row of the
   kind is written at, on the model's length scale — `model.rs`' `length_of`;
   omitted for a retired kind). Give it a `written_steps` arm if a freshly
   written row can be shown at more than one help level, its starting numbers
   in `data/model.json` (`bases` per step, `slopes`), and its steps in
   `help.rs`' `steps_of` if it is a new stored type.
   *Forget `ALL`:* the const assert under it fails the build. *Forget the data,
   or put it out of order:* `kinds.rs`' `the_data_lists_every_kind_in_registry_order`.
2. **The lesson, `crates/sapling-llm/lessons/<type>.json`**: `promptSpec`
   (field list plus one inline example), optional `rulesSpec`, `paramsSpec`,
   `length` (the item key a want's length travels under: `words`, `tiles`),
   `correctiveSpec`,
   optional `escalationSpec`, and `fixtures` — at least one per scenario
   (`spanish`, `mandarin`), citing `{item}` for the want's word and `{other}`
   for a second one — and its arm in `sapling-llm`'s `kinds.rs` `source`.

   **The length is this type's one difficulty knob the model sees**, a count it
   can hit, worked out per want by the top-up planner (`topup.rs`' `length_for`)
   and measured on stored rows the same way (`length_of`). A bank or tray size
   is **not** a knob: every banked type asks for its fullest set, and a help
   level (`help.rs`, `serve.rs`) sizes what a served row shows. `paramsSpec`
   names the length key (and any key derived from it, like a multi-cloze's
   `gaps`, `gaps_for`).
   *Forget the `source` arm:* it is an exhaustive `match`, so it does not compile.
   *Name the wrong key:* `kinds.rs`' tests fail.

   `rulesSpec` holds **any** rule about this type — including one another
   type also needs, spelled out in both (segmentation is in `word-order` and
   `spot-error`). Only rules that name no type belong in `prompts/lesson.txt`.
3. **A wire struct and a `Generated` variant in `wire.rs`**, with its resolver
   arm in `resolve`. `serde` + `schemars` derives are the schema: array
   lengths as `#[schemars(length(...))]`, optional fields `Option`. The resolver
   drops a challenge only for a structural defect, and trims cosmetic ones;
   what it builds must parse as the stored union and pass `check_shape`, or it
   is dropped too.
   *Forget it:* every exhaustive `match` over `WireType` fails to compile.

`lesson.rs`' mock test resolves every kind in both scenarios through that
gate and reads each back with `kind_of`. Keep the mock fixture of a kind a
brand-new word is written short: mock mode serves through the same `fits`, and
a fixture too long for a new word is never served.

## Challenge type, end to end

Each omission is caught by a different gate. That is the design; lean on it
rather than checking by eye.

1. **Wire type** (as above).
   *Forget it:* the type does not exist at all — nothing prompts it, nothing
   parses it.
2. **The stored struct and its rules, in `crates/sapling-challenges`.** In
   `challenge.rs`: the struct (its own tag via `tag!`, fields `camelCase`,
   every optional field `#[serde(default, skip_serializing_if =
   "Option::is_none")] #[ts(optional)]`, doc comments — they travel into the
   TypeScript), its `Challenge` variant, its `ChallengeType` variant (in `ALL`
   and `as_str`), and its arms in `from_value`, the accessors and
   `check_shape`. Then its rule in every exhaustive `match`: `grade.rs`' `check`,
   `model.rs`' `length_of` (how long it reads, on the one scale every slope is
   per), `help.rs`' `has_readings` and `steps_of`, and `serve.rs`'
   `presentation_for` where it has a bank, a tray or a native line. `STORED_TYPES` follows `ALL`, so the
   pool admits the type with no edit of its own.
   *Forget any of it:* the exhaustive `match`es do not compile; a missing `ALL`
   entry fails the const assert.
3. **Its presentation def** in `src/lib/challenges/types/<type>.ts`, listed in
   `types/index.ts`: `reviewsSrs`, `pooled`, and the five presentation facts
   (`correctAnswerText`, `answerIsTargetLanguage`, `answerReading`,
   `spokenAnswerFor`, `audioTexts`). The union it narrows is generated from
   step 2 (`pnpm core:types`).
   *Forget it:* `pnpm check` fails at the registry's mapped type, naming the type.
4. **Component** in `src/routes/learn/`, composed from `blocks/`, plus a branch
   in `ChallengeHost.svelte`'s `{#if}` chain. It grades with `$lib/challenges/check`
   (`validateAnswer` for a typed answer) and reads `$lib/challenges/serve` and
   `$lib/challenges/readings`.
   *Forget it:* the `{:else}` `unhandledChallenge(challenge: never)` fails `pnpm check`.

Add a pooled challenge of the new type to the `broad` golden fixture
(`src/lib/db/fixtures/broad/events.json`), rebless with `pnpm golden:update`,
and check the diff shows it in `getPool` — that pins the materializer admitting
it.

## Rules that are easy to get wrong

- **The stored shape gains additive optional fields only.** Every pooled row
  ever written must keep parsing: a new *required* field turns every old row of
  that type into one the planner cannot read, and it silently stops playing.
  Parsing is lenient (absent or `null` optionals, unknown fields ignored);
  strictness belongs in `check_shape`, which only a fresh row meets.
- Presentation defs import **`$lib/types` and `./def` and nothing else** — an
  explicit allowlist in `challenges/types/registry.test.ts`, so one def
  importing another is caught too.
- Difficulty is deliberately **not** consulted by `check`. Grading stays
  type-blind: a verdict is FSRS's evidence about the *word* and the difficulty
  model's evidence about the row, so difficulty shapes the question stream
  (`sapling-challenges`' `fits.rs` and `stream.rs`), never what an answer is
  worth. Do not "improve" this by weighting grades.
- A multi-string answer crosses the seam as one string (a multi-cloze logs
  `"1: a · 2: b"`); if the new type needs a format like that, the component's
  writer and `grade.rs`' reader are one contract — test them together.
- The component is logic plus composition. Anything that looks like a shared
  skin belongs in `blocks/`, not a scoped override — scoped overrides are how
  the six components drifted apart before.
- `ChallengeHost` is an `{#if}` chain on purpose; a component map loses the
  narrowing.

## Completion criteria

- [ ] Every applicable registration above is done
- [ ] `pnpm core:test` and `pnpm core:check` pass — this is what catches registrations 1 and 2
- [ ] `pnpm check` passes — this is what catches registrations 3 and 4
- [ ] `pnpm test` passes
- [ ] A fixture exists for each mock scenario, so the type is playable offline
- [ ] Played once in mock mode if the change is user-visible

Do not report done on a subset. Delegate the gates to the `verify` agent if you
want them off your context.

## Gotchas

- Prompt and schema changes **only reach the pool via newly generated batches**.
  Existing `ChallengeRow`s keep playing exactly as they were generated — a
  recurring source of "the fix didn't work" reports. Generate a fresh batch
  before judging the change.
