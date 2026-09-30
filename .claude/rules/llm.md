---
paths:
  - "src/lib/llm/**"
  - "crates/sapling-llm/lessons/**"
  - "crates/sapling-llm/prompts/**"
  - "crates/sapling-llm/src/lesson.rs"
  - "crates/sapling-llm/src/wire.rs"
  - "crates/sapling-llm/src/kinds.rs"
  - "crates/sapling-llm/src/escalation.rs"
---

# LLM generation

Stateless: data in, data out, never touches the DB. Every model call runs in Rust (`crates/sapling-llm`, see `core.md`) on the window thread, reached through `callLlm` (`core.ts`); there is no TypeScript chat client. The tool-calling methods take a `ToolContext` in `CallOptions` (`assistant.md`); this layer only declares it and bridges it to wasm. `LlmError` (`core.ts`, its `kind` the generated `ErrorKind`) is the one error class out of it, rebuilt from the error JSON Rust rejects with; `usage.ts` meters the generated `TokenUsage` a live call answers with. Mock mode (`mock.ts`: no key, or `ll.mockMode`) sends no endpoint, and Rust answers with fixtures through the same parser and resolver as a live reply; node tests are always in mock mode.

## The seam

**The planner decides, this layer writes.** The wants come from `sapling-challenges`' top-up planner against the pool (`session.md`); `getBatch(args, {signal, onProgress, itemsPerRequest, reasoningEffort})` hands them to Rust and gets back `{challenges, failedRequests, usage}`. `BatchArgs`, `BatchResult`, `Want` (`{item, kind, length}`), `WantItem`, `ChallengeKind`, `WireType`, `KnownItem` and `ProgressStep` are generated from Rust; the kinds themselves — each wire type's stored shape and length range, in registry order (a seeded top-up pick depends on it) — are `sapling-challenges`' `data/kinds.json`, and `lessons/<type>.json` holds only what the model is told. `getEscalation` builds `shown` — what the learner's screen displayed, from `$lib/challenges/serve`'s `visibleBank`/`visibleTiles` — and Rust does the rest. Local romanization (`$lib/romanize`) stays TypeScript; a `TargetText`'s `reading` is just content the resolver passes into the stored `*Romanization` fields.

`getBatch` returns **challenges and nothing else**: a lesson is written *about* the vocabulary it is given and introduces none. New words enter through `add_words`.

## A top-up (`lesson.rs`)

- **One request per wire type**, at most `REQUEST_ITEMS` (6) distinct words each, spilling into another request of the same type; `REQUEST_CONCURRENCY` (3) in flight (`buffered`), results in request order, brief order within each. A second want of one type for one word is dropped: replies are matched back by the word cited.
- **Prompts are data.** A type's system prompt is `prompts/lesson.txt` with that type's `promptSpec`, `paramsSpec` and `rulesSpec` spliced in (plus `lesson-instruction.txt` where its struct has an `instruction`), static and memoised so a prefix cache pays. It names no other type. Its schema (`batch_schema`, `lesson_<type>`) admits only that type: `schemars` from the wire struct, inlined, every key required, `format` stripped.
- **Difficulty is one count.** Each item is `{id, t, m, <length key>: n}` — the want's `length` under the type's `length` key (`words`, or `tiles` for a word-order), plus a multi-cloze's `gaps` from that length (`kinds.rs`' `gaps_for`: 2 up to eleven words, 3 up to fifteen, then 4). The length is the top-up planner's (`sapling-challenges`' `topup.rs`, worked back from the word's skill and the kind's learned numbers), so no level, no "difficulty" key, no accuracy dial reaches the model. Banks, trays and hints are always written full; a help level (`sapling-challenges`' `serve.rs`) sizes what a served row shows.
- **Payload key order is load-bearing**: native, target, level, topic, interests, about (capped at `MAX_ABOUT_CHARS`), known, then `items` — everything identical across a top-up's requests comes before the first byte that differs.
- **Known words travel as terms**, qualified `term (reading)` only where two cards share a spelling; `term_index` maps a citation back (wanted words claim a bare spelling first). An id is accepted only for a wanted word.
- **A reply is checked against its brief, not counted.** Entries of another type are ignored; each resolved challenge must read back (`kind_of`) as the requested type and cite an unfilled want's word. Fewer than half filled → one corrective retry (`lesson-corrective.txt`); the best partial reply is kept.
- **A request that still fails is dropped**, counted in `failedRequests`; only all of them failing is a `bad-response`. Auth, rate-limit and network errors end the top-up: nothing queued is sent, and requests already in flight finish but are discarded. An aborted signal rejects `fetch`, so it lands there too, and `callLlm` rethrows the signal's reason. An empty brief fails before any step.
- **Progress** is one step per id — `build-prompt`, `request` (naming the model and the request count), `retry` once, `validate` — sent through the wasm `progress` callback; `select-items` and `save` are the session's.
- **The mock** answers each request with that type's own fixtures, one per want, `{item}` bound to the want's word and `{other}` to another word the learner has (a multi-cloze with no second word fills nothing). Spanish or Mandarin by target language. Ids and shuffles are random in both modes.

## The resolver (`wire.rs`)

**The model emits content, never presentation.** Nine wire types on one primitive, `TargetText = {text, reading}` (reading null for Latin scripts); every field is either target-language or native, never conditionally. The resolver picks direction from the type, shuffles options and computes `correctIndex`, places the cloze blank between `before` and `after`, numbers multi-cloze gaps, shuffles tiles, swaps the spot-error word in, and derives `acceptedAnswers` (text, reading, both diacritic-folded). A reading appears only where every piece has one, and a cloze's reading never includes the answer's. It drops a challenge only for a structural defect (no resolvable citation, wrong option count, both sides in one no-space script, a position outside the sentence, a multi-cloze gap without its own word or chip); anything cosmetic is trimmed. **The stored shape is `sapling-challenges`' `Challenge` union** (`challenges.md`) — additive optional fields only: the resolver's output is parsed into it and must pass `check_shape`, or the challenge is dropped like any other structural defect, and `lesson.rs`' mock test resolves every kind in both scenarios through that gate and reads each back as its kind. Mock fixtures for the kinds a brand-new word is written as (recognize-mc, produce-mc) are one- or two-word prompts: mock mode serves through the same `fits`, and a longer fixture would not fit a new word and mock mode would have nothing to play.

## Escalation (`escalation.rs`)

The only mid-session spend, user-initiated. `prompts/escalation.txt` with the `escalationSpec`s spliced in (registry order), the stored challenge plus `shown`, `{answer, overturn}` in reply; anything else is prose and never an overturn. When `shown.nativeLine` is false the overturn rule relaxes to "correct for what was shown". The mock never overturns.

**Adding a wire type** is a data file, a `WireType` variant and a wire struct — the `add-challenge-type` skill has the procedure; `prompt-tuning` covers content changes.
