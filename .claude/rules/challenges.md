---
paths:
  - "crates/sapling-challenges/**"
  - "src/lib/challenges/**"
  - "src/routes/learn/**"
---

# Challenge plugins

Rust decides and TypeScript draws. A stored challenge type is one compile-time plugin with one Rust folder and one frontend folder. Adding a type requires one line in each registry; generic code must not name it.

## Rust contract

- `crates/sapling-challenges/src/types/mod.rs` owns `ChallengePlugin` and the `challenge_types!` registry. The registry generates `Challenge`, `ChallengeType`, `ChallengeScreen`, `ChallengeAnswer`, `STORED_TYPES`, tag-directed deserialization, and dispatch for every plugin operation.
- Each plugin lives in `types/<type>/`: `mod.rs` owns its stored, screen, answer and generation wire shapes; shape checks; help steps; readings/listening facts; serving; audio; grading and stable `answerGiven` text; feedback; legacy-row length measurement; and canonical answer. `type.json` owns its steps, kinds, ranks, length ranges, written steps, and starting difficulty numbers. `lessons/*.json` owns its model instructions and fixtures.
- Stored JSON and event formats are permanent. Parsing remains lenient, new stored fields are additive and optional, help ids/kind ids/kind ranks stay stable, and plugin tests pin logged answer text.
- `Common` is the only per-row view generic code may require: id, direction, item ids, explanation and asked length. `fits`, stream, top-up, replay, protocol and the difficulty model call generated dispatch methods and never match on a challenge variant. `legacy.rs` is the deliberate exception: it freezes the old presentation ladders needed to reconstruct historical answers.
- `Step` is a stable string id. `HelpLevel` only adds generic reading-hidden/listening modifiers and parses/formats the recorded id. A plugin returns only the steps its stored row can distinguish and its own typed screen for a selected level.
- Grading happens once, in the plugin. Components submit typed `ChallengeAnswer` data; `grade` returns verdict, closest accepted form, per-item verdicts, canonical feedback and the exact logged answer string. Difficulty never changes what an answer is worth.
- Kinds belong to plugins. `kinds.rs` flattens every `type.json` in explicit rank order and validates ranks and declared steps. A kind without lengths is retired but still parses/resolves. Match pairs declares no kinds because it is built locally, outside the planner.
- A kind marked `local` in `type.json` (`WireType::is_local`; `cue-cloze` is the first) is planned like any other but built on the device from the learner's own material by `local.rs`' `write_local`, never by the model: it has no lesson file, `llm_kinds()` (what `sapling-llm` iterates for specs, prompts, schemas and glosses) leaves it out, and so does `fits.rs`' `writable`, because the window must widen only to rows a writer can always produce. The planner offers it only to the words its host names in `Scope.cued`, and a local want nothing could be built for is handed on as a model-written want for the same word (`topup.rs`' `instead_of_local`). A new local kind adds a builder arm in `write_local` and the material it needs to `write_local`'s arguments. A kind may name `startsFrom` (cue-cloze: `cloze`): until its own answers move a base or its slope, `Shared` reads that kind's *learned* number, not the fixed starting one — a learner's numbers drift far from the starting values, and a new kind on fixed ones would never fit.
- Generation wire structs, lesson sources, schemas and resolution live in `sapling-challenges`; `sapling-llm` keeps prompt assembly, calls and batch orchestration. Shared resolver/text/schema helpers may remain generic.
- Global model values remain in `data/model.json`; per-kind bases, slopes and length ranges live in plugin `type.json` files. The model still uses asked length first and the plugin's `measure` only for older rows.

## Frontend contract

- `src/lib/challenges/types/<type>/<Component>.svelte` is the UI half. It receives `ChallengeProps<T>`: the narrowed stored challenge, the narrowed plugin screen, optional `Graded`, and `onanswer(AnswerOf<T>, responseMs)`. It renders and reports learner actions; it does not grade, select visible bank entries/tiles, compute feedback, or infer the correct answer.
- `src/lib/challenges/types/index.ts` is the mapped component registry over generated `ChallengeType`. `ChallengeHost.svelte` performs the one sound registry cast and has no per-type branches.
- Shared controls live in `src/lib/challenges/blocks/`. Shared reading rendering stays in `readings.ts`; it applies the plugin screen's reading flag but owns no challenge decisions.
- `plugin.ts` is the synchronous protocol wrapper. `serveChallenge` returns `{screen, audio, shown}`; `gradeChallenge` returns `Graded`; canonical skip feedback and registry flags cross the same boundary. The session and feedback banner use these results and never inspect a challenge type.
- Escalation receives the exact served `ChallengeScreen`, not a reconstructed presentation.

## Stable flow

1. The stream selects a stored row and help id.
2. Rust serves it through the registered plugin and returns its typed screen, audio and normalized shown id.
3. The registry renders the component; the component submits its typed answer.
4. Rust grades it through the same plugin. The session files `graded.logged`, verdict and optional item verdicts, then passes `Graded` back to the component and banner.

## Gates

- `cargo build` catches missing trait implementations and registry wiring.
- Generic registry tests cover every registered plugin: stored JSON round-trip, shape, every help screen's JSON round-trip, serving, canonical correct grading, stable logged text, and a wrong-answer case.
- Kind-data tests require unique contiguous ranks, declared written steps, and complete kind coverage.
- `pnpm check` fails at the mapped component registry when a Rust type has no UI.
- Golden, calibration, Rust, wasm and frontend suites protect stored rows, events, help ids, seeded kind order, model values and learner-visible behavior.

Use `.claude/skills/add-challenge-type/SKILL.md` for the concrete procedure.
