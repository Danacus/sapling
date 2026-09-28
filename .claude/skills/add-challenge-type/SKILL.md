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
   two kinds share that pair) and `plannable` (`{demand, levels}`: the tier its
   stored challenge reports and the rungs it is written at; omitted for a
   retired kind).
   *Forget `ALL`:* the const assert under it fails the build. *Forget the data,
   or put it out of order:* `kinds.rs`' `the_data_lists_every_kind_in_registry_order`.
2. **The lesson, `crates/sapling-llm/lessons/<type>.json`**: `promptSpec`
   (field list plus one inline example), optional `rulesSpec`, `paramsSpec`,
   `params` (each size key and its value at rungs 1..5), `correctiveSpec`,
   optional `escalationSpec`, and `fixtures` — at least one per scenario
   (`spanish`, `mandarin`), citing `{item}` for the want's word and `{other}`
   for a second one — and its arm in `sapling-llm`'s `kinds.rs` `source`.

   **`params` is this type's difficulty**, as counts the model can hit
   (`words`, `tiles`, `gaps`): the same keys at every rung, monotone, aligned
   with the stored side's scales (`sapling-challenges`' `data/difficulty.json`,
   the 1-to-12-word prose scale). A bank or tray size is **not** a
   rung-varying key: every banked type asks for its fullest set, and
   `sapling-challenges`' `serve.rs` sizes what a served row shows.
   `paramsSpec` names exactly those keys.
   *Forget the `source` arm:* it is an exhaustive `match`, so it does not compile.
   *Get the ladder wrong:* `kinds.rs`' tests fail.

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
gate, reads each back with `kind_of`, and checks each plannable kind's stated
demand against `demand_of` of the challenge it resolved to.

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
   `difficulty.rs`' `demand_of` and `within_tier` (a `base` in
   `data/difficulty.json` for where the *format* stands among its tier-mates,
   its structural knobs on the shared `length_knob` scale), and `serve.rs` where
   it has a bank, a tray or a native line. `STORED_TYPES` follows `ALL`, so the
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
- `demand` is deliberately **not** consulted by `check`. Grading stays
  type-blind: a verdict is FSRS's evidence about the *word*, so difficulty
  shapes the question stream (`sapling-challenges`' `ladder.rs` and
  `session.rs`), never what an answer is worth. Do not "improve" this by
  weighting grades.
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
