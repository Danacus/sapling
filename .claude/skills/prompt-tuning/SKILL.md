---
name: prompt-tuning
description: >
  Change what the generation model writes — lesson quality, tone, difficulty,
  answerability, readings. Use when challenges come out bland, too easy or hard,
  ambiguous, mis-romanized, or otherwise wrong in *content* rather than in code,
  and when editing SYSTEM_PROMPT, a promptSpec, correctiveSpec or escalationSpec.
---

# Tuning the generation prompt

**Prompt edits are the fix of first resort for content-quality bugs.** Before
adding a validator or a guard, ask whether the prompt can simply stop producing
the defect. The resolver's job is assembly, not correction.

## Where the text lives

The composed prompt is assembled from parts — do not hand-write a monolith.

| Text | Lives in | Scope |
|---|---|---|
| `Types:` block | each def's `promptSpec` in `llm/challenge-types/<type>.ts` | one type |
| `Rules:` block, per-type part | each def's `rulesSpec` (optional; spliced into `generate.ts`'s array) | one type |
| Retry fragment | each def's `correctiveSpec` | one type |
| Escalation gloss | each def's `escalationSpec`, composed by `escalation.ts` | one type |
| `Rules:` block, cross-type part | hand-written in `generate.ts` | genuinely cross-type only |
| Which type gets written, and how hard | **not prose at all** — `llm/slots.ts` | see below |

If a rule names one type, it belongs in that def's `promptSpec` (a field-list
addendum) or `rulesSpec` (a `Rules:`-block bullet) — never hand-written into
`generate.ts`. That includes a type's own **difficulty gradient**: the sentence
saying which observable, countable knob to turn at which level (shown-text
length, tile count, bank size, sentence length, distractor closeness) is a line
in that type's `rulesSpec`, appended to its existing bullet where it has one.
`generate.ts`'s hand-written `Rules:` entries are reserved for rules that by
definition span types (the slot rule, segmentation, sides-never-swap, the one
shared difficulty-ladder line).

## Type choice — and difficulty choice — is code, not prompt

A lesson's shape is planned locally by `planSlots` (`src/lib/llm/slots.ts`) and
handed to the model as an explicit `slots` list, each entry now carrying its own
`difficulty` (1..5) alongside its `type`. **Do not write a prompt rule about
which type to use, or add a new accuracy threshold** — either will be ignored at
best and fight the plan at worst. Everything below belongs in `slots.ts`, with a
unit test in `slots.test.ts`:

- ladder floors (what a level-1 / level-2-3 / level-4-5 word may be asked — see
  `$lib/session/progression`'s `difficultyLevelOf`)
- the recognition-vs-production mix, and how `recentAccuracy` moves it
  (`productionShare`, continuous)
- each slot's own `difficulty`: the item's level, shifted by `recentAccuracy`
  and pulled down a rung for a `recentMistakes` word
- whether a cloze gets a word bank (`bank: true|false` on the slot)
- the extra go a `recentMistakes` term earns, and `'(skipped)'` → recognition

What stays prose is *content* calibration given a slot's `difficulty`: how long
an answer should be, how hard the sentence reads (each type's own gradient
line), "easier than last time", voice, answerability. `recentAccuracy` itself
never reaches the model — only its already-folded effect on `difficulty` and
`productionShare` does.

## Constraints on `SYSTEM_PROMPT`

- It is **static and token-budgeted**, deliberately, because a static string is
  prompt-cache friendly — and a lesson is now several concurrent chunk requests
  that all quote it, so the cache matters more than before, not less. Never
  interpolate per-session values into it; per-user signals (`recentMistakes`,
  `slots` and each slot's `difficulty`) travel in the request, not the system
  prompt — `recentAccuracy` itself never travels at all, only its already-folded
  effect on `difficulty`.
- Its load-bearing blocks are voice/anti-blandness, the one-line `TargetText`
  reading rule, answerability, the slot rule, and the difficulty ladder line
  (paired with every type's own gradient in its `rulesSpec`). Deleting one to
  save tokens regresses a whole class of output — say which block you are
  changing and why.
- Composition keeps it a static string. Adding a def module does not change that.
- One chunk sees only its own few words. A rule phrased "across the batch" is no
  longer enforceable by the model — write it per reply, or move it to `slots.ts`.

## What the resolver will and won't rescue

`resolveBatch` **degrades cosmetic defects silently** — a partial reading is
dropped, never the challenge — and drops **only structural failures**. So:

- A cosmetic defect that survives to the user is a prompt bug.
- A challenge vanishing from a batch is a schema/structure bug.

Don't add resolver logic to paper over a prompt problem; the whole point of the
wire format is that bad shapes are unexpressible rather than guarded against.

## Iterating without spending tokens

Mock mode routes deterministic fixtures through the **real** parse/resolve path,
so schema and resolver changes are testable offline. But mock fixtures do not
tell you whether the *model* obeys new prose. Judging tone, difficulty or
answerability needs one real generated batch.

## The trap

**Prompt changes only reach the pool via newly generated batches.** Every
existing `ChallengeRow` keeps playing exactly as it was generated. Generate a
fresh batch before deciding the edit didn't work — this is the single most
common false negative here.

## Completion criteria

- [ ] The edit is in the narrowest place that covers it (def `promptSpec`/`rulesSpec` over hand-written `Rules:`)
- [ ] Nothing about *which type to write*, or a new accuracy threshold, was added to the prompt — both are `slots.ts`
- [ ] `SYSTEM_PROMPT` is still a static string
- [ ] `pnpm test` passes (fixtures + registry parity)
- [ ] Judged against a **freshly generated** batch, not the existing pool
