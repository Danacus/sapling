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
| Retry fragment | each def's `correctiveSpec` | one type |
| Escalation gloss | each def's `escalationSpec`, composed by `escalation.ts` | one type |
| `Rules:` block | hand-written in `generate.ts` | genuinely cross-type only |

If a rule names one type, it belongs in that def's `promptSpec`. The `Rules:`
block is reserved for rules that by definition span types (segmentation,
sides-never-swap, difficulty calibration).

## Constraints on `SYSTEM_PROMPT`

- It is **static and token-budgeted**, deliberately, because a static string is
  prompt-cache friendly. Never interpolate per-session values into it; per-user
  signals (`recentAccuracy`, `recentMistakes`) travel in the request, not the
  system prompt.
- Its load-bearing blocks are voice/anti-blandness, the one-line `TargetText`
  reading rule, answerability, and difficulty calibration. Deleting one to save
  tokens regresses a whole class of output — say which block you are changing
  and why.
- Composition keeps it a static string. Adding a def module does not change that.

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

- [ ] The edit is in the narrowest place that covers it (def `promptSpec` over `Rules:`)
- [ ] `SYSTEM_PROMPT` is still a static string
- [ ] `pnpm test` passes (fixtures + registry parity)
- [ ] Judged against a **freshly generated** batch, not the existing pool
