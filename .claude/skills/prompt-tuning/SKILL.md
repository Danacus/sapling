---
name: prompt-tuning
description: >
  Change what the generation model writes — lesson quality, tone, difficulty,
  answerability, readings. Use when challenges come out bland, too easy or hard,
  ambiguous, mis-romanized, or otherwise wrong in *content* rather than in code,
  and when editing a promptSpec, paramsSpec, rulesSpec, correctiveSpec or
  escalationSpec, or generate.ts's shared prompt preamble.
---

# Tuning the generation prompt

**Prompt edits are the fix of first resort for content-quality bugs.** Before
adding a validator or a guard, ask whether the prompt can simply stop producing
the defect. The resolver's job is assembly, not correction.

## There is no single system prompt

**One generation request is about exactly one wire type.** `systemPromptFor(def)`
in `generate.ts` composes that type's own prompt: a shared preamble that names no
type at all, then *only* that def's `promptSpec`, `paramsSpec` and `rulesSpec`.
Seven types, seven prompts, each static and memoised. So "edit the system prompt"
is always a question of *which* of the three places below.

| Text | Lives in | Scope |
|---|---|---|
| A type's field list and example | its `promptSpec` in `llm/challenge-types/<type>.ts` | one type |
| What each parameter key means | its `paramsSpec` | one type |
| Any other rule about a type | its `rulesSpec` | one type — **even if a second type needs the same rule** |
| Retry fragment | its `correctiveSpec` | one type |
| Escalation gloss | its `escalationSpec`, composed by `escalation.ts` | one type |
| The shared preamble | hand-written in `generate.ts` | rules that name **no** type |
| Which kind gets written, and how hard | **not prose at all** — `session/topup.ts` + each def's `params` | see below |

If a rule names a type, it belongs in that def — never in the preamble. A rule
two types need is written out in **both** (segmentation is spelled out in full in
`word-order` and in `spot-error`): each copy only ever travels on its own type's
calls, so duplication costs nothing it did not already cost, and the preamble
stays what every type pays for. The preamble is JSON-only, the envelope, the
`TargetText` reading rule, the `itemIds`/known citation rules, sides-never-swap,
plausible wrong options, answerability, voice/anti-blandness, `explanation`, and
"known is what you build with" — plus the `instruction` heading rule, which is
spliced in automatically for a type whose schema has that field.

## Kind choice — and difficulty — is code, not prompt

What gets written is decided by the session's top-up planner (`planTopUp` in
`src/lib/session/topup.ts`) from what the pool is missing; the LLM layer plans
nothing. **Do not write a prompt rule about which type to use, or add an
accuracy threshold anywhere** — the first will be ignored at best and fight the
brief at worst, and the second is a mechanism the design deliberately has none
of (FSRS already lowers a missed word's strength, which lowers its rung, which
shortens what is written about it). Everything below belongs in `topup.ts`,
with a unit test in `topup.test.ts`:

- which kinds a rung may be asked (`demandForLevel` in
  `$lib/session/progression`, against each kind's `demand` in
  `llm/requests.ts`' `PLANNABLE_KINDS`)
- how many fresh challenges a word should have waiting (`WANT_PER_WORD`), and in
  which groups (a recognition kind and a production kind, or two recognition
  kinds before production is bearable)
- what counts as coverage (rested, playable, bearable — `session/pool.ts`)
- which kind wins among the missing ones (never-had first, then `rng`)
- the top-up cap (`MAX_TOPUP_WANTS`)

**Difficulty never reaches the model as a number on a scale.** The rung is the
word's own `difficultyLevelOf`, on the want; what travels is each def's
`params(rung, kind)` — a sentence length, a bank size, a tile count, on the item
itself. To make challenges easier or harder for a type, edit that def's `params`
ladder (and keep it monotone; `registry.test.ts` checks, and also checks a
rung-1 challenge scores a lower stored `difficultyOf` than a rung-5 one). Do
**not** reintroduce a "difficulty 1-5" line: a number the model has to interpret
is exactly what the counts replaced. What stays prose in a `rulesSpec` is the
judgement no count expresses — distractor closeness, how subtle a planted error
should be — stated once, with no rung attached.

## Constraints on a type's prompt

- Each one is **static and token-budgeted**, deliberately, because a static
  string is prompt-cache friendly — and a lesson's requests of one kind all quote
  it. Never interpolate per-session values into it; per-user signals travel in
  the user payload.
- Nothing about how the learner has been doing travels, and nothing local reads
  it either: a missed word's strength has already fallen, so its rung and its
  sizes fell with it. "Write this one easier" on top of a length that already
  says how long to write it was two instructions for one decision.
- Load-bearing blocks: voice/anti-blandness, the `TargetText` reading rule,
  answerability, the `items` rule, and the size-is-a-target rule. Deleting one to
  save tokens regresses a whole class of output — say which block you are
  changing and why.
- One reply is now six challenges of the **same** type, which is where a model
  starts writing variations on one sentence. The no-repeated-frame rule in the
  voice block matters more than it did, not less.
- A rule phrased "across the batch" is not enforceable by the model — one request
  sees only its own words. Write it per reply, or move it to `slots.ts`.

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

- [ ] The edit is in the narrowest place that covers it (def `promptSpec`/`paramsSpec`/`rulesSpec` over the shared preamble)
- [ ] Nothing about *which type to write* was added to the prompt (that is `session/topup.ts`), and no accuracy threshold was added anywhere
- [ ] No difficulty scale was reintroduced: difficulty is each def's `params`, in counts
- [ ] Every type's prompt is still a static string, and names no other type
- [ ] `pnpm test` passes (fixtures + registry parity)
- [ ] Judged against a **freshly generated** batch, not the existing pool
