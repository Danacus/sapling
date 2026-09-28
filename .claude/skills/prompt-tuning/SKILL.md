---
name: prompt-tuning
description: >
  Change what the generation model writes — lesson quality, tone, difficulty,
  answerability, readings. Use when challenges come out bland, too easy or hard,
  ambiguous, mis-romanized, or otherwise wrong in *content* rather than in code,
  and when editing a promptSpec, paramsSpec, rulesSpec, correctiveSpec or
  escalationSpec in crates/sapling-llm/lessons/, or the shared preamble in
  crates/sapling-llm/prompts/lesson.txt.
---

# Tuning the generation prompt

**Prompt edits are the fix of first resort for content-quality bugs.** Before
adding a validator or a guard, ask whether the prompt can simply stop producing
the defect. The resolver's job is assembly, not correction.

## There is no single system prompt

**One generation request is about exactly one wire type.** `system_prompt(kind)`
in `crates/sapling-llm/src/lesson.rs` composes that type's own prompt: a shared
preamble that names no type at all, then *only* that type's `promptSpec`,
`paramsSpec` and `rulesSpec`. One prompt per type, each static and memoised. So
"edit the system prompt" is always a question of *which* place below. All paths
are under `crates/sapling-llm/`.

| Text | Lives in | Scope |
|---|---|---|
| A type's field list and example | its `promptSpec` in `lessons/<type>.json` | one type |
| What each parameter key means | its `paramsSpec` | one type |
| Any other rule about a type | its `rulesSpec` | one type — **even if a second type needs the same rule** |
| Retry fragment | its `correctiveSpec`, inside `prompts/lesson-corrective.txt` | one type |
| Escalation gloss | its `escalationSpec`, spliced into `prompts/escalation.txt` | one type |
| The shared preamble | `prompts/lesson.txt` (+ `lesson-instruction.txt`) | rules that name **no** type |
| Which kind gets written, and how hard | **not prose at all** — `sapling-challenges`' `topup.rs` + each type's `params` | see below |

If a rule names a type, it belongs in that def — never in the preamble. A rule
two types need is written out in **both** (segmentation is spelled out in full in
`word-order` and in `spot-error`): each copy only ever travels on its own type's
calls, so duplication costs nothing it did not already cost, and the preamble
stays what every type pays for. The preamble is JSON-only, the envelope, the
`TargetText` reading rule, the `itemIds`/known citation rules, sides-never-swap,
plausible wrong options, answerability, voice/anti-blandness, `explanation`, and
"known is what you build with" — plus the `instruction` heading rule, which is
spliced in automatically for a type whose wire struct has that field.

## Kind choice — and difficulty — is code, not prompt

What gets written is decided by the top-up planner (`plan_top_up` in
`crates/sapling-challenges/src/topup.rs`) from what the pool is missing; the
LLM layer plans nothing. **Do not write a prompt rule about which type to use, or add an
accuracy threshold anywhere** — the first will be ignored at best and fight the
brief at worst, and the second is a mechanism the design deliberately has none
of (FSRS already lowers a missed word's strength, which lowers its rung, which
shortens what is written about it). Everything below belongs in `topup.rs`,
with a `cargo test` beside it:

- which kinds a rung may be asked (`demand_for_level` in `ladder.rs`, against
  each kind's `plannable` in `sapling-challenges`' `data/kinds.json`)
- how many fresh challenges a word should have waiting (`WANT_PER_WORD`), and in
  which groups (a recognition kind and a production kind, or two recognition
  kinds before production is bearable)
- what counts as coverage (rested, playable, bearable — `pool.rs`)
- which kind wins among the missing ones (never-had first, then a draw)
- the top-up cap (`MAX_TOPUP_WANTS`)

**Difficulty never reaches the model as a number on a scale.** The rung is the
word's own (`Word::level`), on the want; what travels is that type's
`params` at the rung — a sentence length, a tile count, on the item itself. To
make challenges easier or harder for a type, edit its `params` ladder (and keep
it monotone; `kinds.rs`' tests check). Do
**not** reintroduce a "difficulty 1-5" line: a number the model has to interpret
is exactly what the counts replaced. What stays prose in a `rulesSpec` is the
judgement no count expresses — distractor closeness, how subtle a planted error
should be — stated once, with no rung attached.

## Constraints on a type's prompt

- Each one is **static and token-budgeted**, deliberately, because a static
  string is prompt-cache friendly — and a top-up's requests of one kind all
  quote it. Never interpolate per-session values into it; per-user signals
  travel in the user payload.
- Nothing about how the learner has been doing travels, and nothing local reads
  it either: a missed word's strength has already fallen, so its rung and its
  sizes fell with it. Do not add a "write this one easier" hint on top of a
  length that already says how long to write it.
- Load-bearing blocks: voice/anti-blandness, the `TargetText` reading rule,
  answerability, the `items` rule, and the size-is-a-target rule. Deleting one to
  save tokens regresses a whole class of output — say which block you are
  changing and why.
- One reply is six challenges of the **same** type, which is where a model
  starts writing variations on one sentence. The no-repeated-frame rule in the
  voice block carries extra weight for that reason.
- A rule phrased "across the batch" is not enforceable by the model — one request
  sees only its own words. Write it per reply, or make it a want-level decision
  in `topup.rs`.

## What the resolver will and won't rescue

The resolver (`wire.rs`) **degrades cosmetic defects silently** — a partial reading is
dropped, never the challenge — and drops **only structural failures**. So:

- A cosmetic defect that survives to the user is a prompt bug.
- A challenge vanishing from a batch is a schema/structure bug.

Don't add resolver logic to paper over a prompt problem; the whole point of the
wire format is that bad shapes are unexpressible rather than guarded against.

## Iterating without spending tokens

Mock mode routes each type's fixtures through the **real** batch loop, parser
and resolver, so schema and resolver changes are testable offline. But mock fixtures do not
tell you whether the *model* obeys new prose. Judging tone, difficulty or
answerability needs one real generated batch.

## The trap

**Prompt changes only reach the pool via newly generated batches.** Every
existing `ChallengeRow` keeps playing exactly as it was generated. Generate a
fresh batch before deciding the edit didn't work — this is the single most
common false negative here.

## Completion criteria

- [ ] The edit is in the narrowest place that covers it (a type's `promptSpec`/`paramsSpec`/`rulesSpec` over the shared preamble)
- [ ] Nothing about *which type to write* was added to the prompt (that is `topup.rs`), and no accuracy threshold was added anywhere
- [ ] No difficulty scale was reintroduced: difficulty is each type's `params`, in counts
- [ ] Every type's prompt is still a static string, and names no other type
- [ ] `pnpm core:test` and `pnpm test` pass (prompt composition, fixtures, the wasm wiring test)
- [ ] Judged against a **freshly generated** batch, not the existing pool
