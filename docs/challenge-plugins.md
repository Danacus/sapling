# Challenge types as plugins

Status: **implemented** (2026-10-11). The recommendations in the open questions were adopted: Rust owns presentation facts, generation belongs to plugins, match pairs has no kinds, and retired `translate-to-target` remains readable.

## Why

A challenge type should be a module: one place that says what the type stores, how the model writes it, what it shows at each help level, how an answer is graded and what the learner sees. Today it is not. Knowledge of a single type is spread across the system and held together by exhaustive `match`es that fail to compile when one is forgotten. That is a good safety net, but it is not a boundary.

Measured on `cloze` at `016dc6e`:

- **Rust**: the type is named in `challenge.rs` (its struct plus eight `match`es: parse, kind, id, direction, item ids, asked length, set length, shape check), `kinds.rs` (`WireType`, `written_steps`), `data/kinds.json`, `data/model.json`, `help.rs` (`steps_of`, `step_for_sizes`, `has_readings`, and the shared `Step` enum that lists every type's steps), `serve.rs` (`presentation_for`, `visible_bank`), `grade.rs` (`check`), `model.rs` (`length_of`), `legacy.rs`, `sim.rs`, and in `sapling-llm` `wire.rs` (a wire struct, a `Generated` variant, a resolver arm), `kinds.rs` (a `source` arm) and `lessons/cloze.json`. Adding a type is about 25 edits in roughly 15 files across two crates, plus the frontend.
- **Frontend**: a presentation def (`types/cloze.ts`), a registry entry, a component in `routes/learn/`, a branch in `ChallengeHost.svelte`, and per-type branches in `escalation.ts` (`describeShown`).
- **Grading is split**: Rust has the string matchers and an unused per-type `check`; each Svelte component decides its own verdict (multiple choice by index, word order by token sequence, cloze through `validateAnswer` with a fuzzy flag). Two rules that can drift, and the one that runs lives in a view.
- **One shared struct stands in for every screen**: `Presentation { showHint, bankSize, distractorTiles, … }` carries cloze's bank, word order's tray and every type's native line, so each type's screen is a field of everyone's.
- **Three vocabularies with no owner**: nine *kinds* (what the model is asked for) map onto seven stored *types*, shown at *steps* drawn from one global enum.

The generic machinery is in better shape than this suggests: in production code `fits.rs`, `stream.rs`, `topup.rs`, `pool.rs` and `replay.rs` barely name a type. What they need from types comes through `help.rs`, `kinds.rs` and `model.rs`. So the work is to give those per-type facts one home, not to rewrite the difficulty model.

## Goals

1. **One type, two folders.** All of a type's Rust in one module directory, all of its UI in one frontend directory. Adding a type means writing those two folders and adding one line to each registry.
2. **Generic code never names a type.** Pool, stream, top-up, fits, replay, the model, the protocol, lesson writing, the session and the feedback banner work through the plugin contract only.
3. **Rust decides, TypeScript draws.** Grading, what a help level shows, and every fact about the right answer are the plugin's Rust half. A component renders a screen and reports what the learner did.
4. **Each screen is the type's own.** A type defines its own screen and answer shapes; nothing shared carries another type's fields.
5. **Forgetting something still fails a gate**, now at the plugin, with a conformance suite every type must pass.

## Non-goals

- No runtime or third-party plugins. Registration is at compile time; the app ships with the types it was built with.
- No change to the difficulty model, the serving rules, the top-up planner or the session flow.
- No new types and no change to what the learner sees.
- No change to anything stored or synced (next section).

## What must not move

This is a reorganisation of code. Every one of these stays byte-identical, and the golden fixtures and the calibration fixtures must pass unchanged at every slice:

- **Stored rows.** The JSON value of every pooled challenge: field names, the `type` tag, optional fields absent rather than `null`. Lenient parsing stays: old rows keep reading, unknown fields are ignored.
- **Events.** Every payload, including `answerGiven`, whose format today differs per type (the chosen option's text, the tapped token, the assembled sentence, `"1: a · 2: b"` for a multi-cloze, `"5 pairs, 1 mistake"` for a match round). The plugin owns producing that string, and its tests pin it.
- **Help-level ids** (`pick-6`, `typed-hidden`, `listening`, …). Answers record them as `shown`, and the learned difficulty numbers are keyed by them.
- **Kind ids** (`recognize-mc`, `cloze`, …) and **kind order**. The order is the planner's tie-break and the seeded draws depend on it, so the simulated-learner fixture and `invariants.rs` only stay put if it does.
- **Model data values**: every base, slope and length range keeps its number; only the file it lives in changes.
- **Verdicts.** For every answer the app can produce today, the new grader returns the same verdict, closest accepted form and per-item verdicts.

## Vocabulary

- **Type**: a stored shape with its own `type` tag (`cloze`, `multi-cloze`, …). One plugin per type.
- **Kind**: one way the model is asked to write a type. A type has zero or more kinds: multiple choice has three (`recognize-mc`, `produce-mc`, `context-mc`), typed translation two, cloze one, match pairs none (it is built locally). Kinds belong to their type.
- **Step**: one level of help a type offers, named by a stable string. Steps are declared by the type, not by a global enum.
- **Help level**: a step plus the two generic modifiers, reading hidden and listening. The id format is unchanged.
- **Screen**: what one row shows at one help level, in the type's own shape.
- **Answer**: what the learner did, in the type's own shape (an index, positions in a bank, typed text).
- **Graded**: the verdict and everything the feedback needs, returned by the plugin.

## The Rust half

### Layout

```
crates/sapling-challenges/src/types/
  mod.rs                 the registry: one challenge_types! line per plugin
  cloze/
    mod.rs               impl ChallengePlugin for Cloze
    type.json            kinds, steps, starting difficulty numbers
    lessons/cloze.json   what the model is told, and the mock fixtures
    tests.rs             type-specific cases (the conformance suite runs on its own)
  multi_cloze/ …
```

### The contract

A sketch. Names and exact signatures are settled in the first slice; the shape is the point.

```rust
pub trait ChallengePlugin: 'static {
    /// The stored `type` tag. Stable forever.
    const TAG: &'static str;
    /// Whether an answer files reviews (false for match pairs).
    const REVIEWS: bool;
    /// Whether rows are pool rows written to the log (false for match pairs).
    const POOLED: bool;

    type Stored: Serialize + DeserializeOwned + TS + Clone;
    type Screen: Serialize + TS;
    type Answer: Serialize + DeserializeOwned + TS;
    type Wire: DeserializeOwned + JsonSchema;   // an enum over this type's kinds

    // The row
    fn common(row: &Self::Stored) -> &Common;   // id, direction, item ids, explanation, asked length
    fn check_shape(row: &Self::Stored) -> Result<(), String>;

    // Showing it
    fn steps(row: &Self::Stored) -> Vec<Step>;  // only the steps this row can tell apart, easiest first
    fn has_readings(row: &Self::Stored) -> bool;
    fn can_listen(row: &Self::Stored) -> bool { false }
    fn screen(row: &Self::Stored, at: &HelpLevel) -> Self::Screen;
    fn audio_texts(row: &Self::Stored) -> Vec<String>;

    // Answering it
    fn grade(row: &Self::Stored, at: &HelpLevel, answer: &Self::Answer) -> Graded;
    fn logged(row: &Self::Stored, answer: &Self::Answer) -> String; // the answerGiven string, unchanged

    // Difficulty
    fn measure(row: &Self::Stored) -> f64;      // length of a row written before `length` was stored

    // Writing it
    fn resolve(wire: Self::Wire, ctx: &mut Resolver) -> Option<Self::Stored>;

    // Testing and simulation
    fn example(kind: &Kind, items: &[&str], length: u8, rng: &mut Rng) -> Self::Stored;
    fn correct_answer(row: &Self::Stored, at: &HelpLevel) -> Self::Answer;
}

pub struct Graded {
    pub verdict: Verdict,
    pub closest_accepted: Option<String>,
    pub item_verdicts: Option<Vec<GapVerdict>>, // per word, when a type grades words separately
    pub feedback: Feedback,                     // the right answer, its reading, what to speak
}
```

`Feedback` absorbs the five presentation facts the frontend defs hold today (`correctAnswerText`, `answerIsTargetLanguage`, `answerReading`, `spokenAnswerFor`; `audioTexts` is the trait method above). They are pure functions of the row, so they belong with the row.

The trait is `ChallengePlugin` because `ChallengeType` is already the name of the tag enum (and of the generated TypeScript union of tags), which stays.

`Step` is a string id, declared in the type's `type.json`. Whether a step shows the native line is part of that type's screen, not a global rule.

`Common` holds the fields every stored type carries. Whether that is a `#[serde(flatten)]` struct or a small macro that implements `common()` over per-struct fields is decided in slice 0, by which one keeps stored JSON values identical with the least machinery.

### The registry

```rust
challenge_types! {
    multiple_choice::MultipleChoice,
    cloze::Cloze,
    typed_translation::TypedTranslation,
    match_pairs::MatchPairs,
    multi_cloze::MultiCloze,
    word_order::WordOrder,
    spot_error::SpotError,
}
```

The macro generates what is hand-written today: the `Challenge` enum with its tag-dispatching `Deserialize`, the `ChallengeType` id enum with `ALL`, `as_str` and `parse`, `STORED_TYPES`, the tagged `ChallengeScreen` and `ChallengeAnswer` enums (and their TypeScript unions through ts-rs), and one dispatch function per trait method over `Challenge`. The rest of the crate calls those dispatch functions and never matches on a variant.

### Kinds and data

Each type's `type.json` holds its kinds and its numbers:

```json
{
  "steps": ["pick-4", "pick-6", "typed"],
  "kinds": [
    {
      "id": "cloze",
      "rank": 7,
      "direction": "toTarget",
      "lengths": [3, 11],
      "writtenSteps": ["pick-4", "pick-6", "typed"],
      "canListen": false,
      "bases": { "pick-4": 1.1, "pick-6": 1.9, "typed": 3.1 },
      "slope": 0.12
    }
  ]
}
```

- `rank` keeps today's kind order (`recognize-mc` 1 … `translate-to-target` 9) explicit, because it interleaves types and the seeded draws depend on it. A test asserts ranks are unique and contiguous.
- A kind without `lengths` is retired: still parsed and resolved, never planned (today's `translate-to-target`).
- The global numbers (aims, window, rates, new-word memory and chance, the hidden and listening offsets) stay in `data/model.json`.
- `kinds.rs` becomes a generic view over every type's kinds, in rank order. `kind_of(row)` asks the row's own type which of its kinds wrote it.

### What generic code keeps

| Today | After |
|---|---|
| `challenge.rs`: seven structs, eight `match`es, `check_shape` | Each struct and its shape check in its plugin; the enum and dispatch are generated |
| `kinds.rs` + `data/kinds.json`: `WireType`, `written_steps`, `can_listen` | Generic view over each plugin's `type.json` kinds |
| `help.rs`: global `Step` enum, `steps_of`, `step_for_sizes`, `has_readings`, `can_listen` | `HelpLevel` (id parse and format) stays generic; everything per type moves to the plugins |
| `serve.rs`: `Presentation`, `presentation_for`, `visible_bank`, `visible_tiles` | Each plugin's `screen`; the bank and tray selection helpers become shared utilities plugins call |
| `grade.rs`: per-type `check` | Each plugin's `grade`; `matcher.rs` stays the shared string matcher |
| `model.rs`: per-type `length_of` | `asked length` from `Common`, else the plugin's `measure`; the model itself is untouched |
| `fits.rs`, `stream.rs`, `topup.rs`, `pool.rs`, `replay.rs` | Unchanged apart from calling dispatch functions |
| `sim.rs`: a synthetic row per kind | Each plugin's `example` |
| `legacy.rs`: frozen copies of the old serve ladders | Stays as it is. It is a frozen reconstruction of old data and is allowed to name types |
| `sapling-llm` `wire.rs`, `kinds.rs`, `lessons/*.json` | Wire structs, resolvers and lesson specs move into the plugins. `sapling-llm` keeps prompt assembly and the model call, and gets each kind's spec, JSON schema and resolver from the registry |

## The frontend half

### Layout

```
src/lib/challenges/
  types/
    index.ts             the registry: one line per type
    cloze/Cloze.svelte
    multi-cloze/MultiCloze.svelte
    …
  blocks/                PromptHeader, TapOption, TapRow, CheckButton… (moved from routes/learn/blocks)
  ChallengeHost.svelte   looks the component up; no per-type branches
```

The per-type def modules (`types/cloze.ts` and the rest) disappear: their facts are the plugin's `Feedback` and `audio_texts`, and `reviewsSrs` and `pooled` come from the generated registry table.

### The component contract

```ts
interface ChallengeProps<T extends ChallengeType> {
	challenge: ChallengeOf<T>;
	screen: ScreenOf<T>;             // generated from the plugin's Screen
	graded?: Graded;                 // set once answered: the component shows its locked state from it
	onanswer: (answer: AnswerOf<T>) => void; // generated from the plugin's Answer
	targetLanguage?: string;
	nativeLanguage?: string;
	tokenize?: ((text: string) => RomanizedToken[]) | null;
}
```

A component draws `screen` and reports `answer`. It never grades, never decides which bank entries or tiles show, and never computes the right answer. One allowance: it may use its own row for feedback *during* an interaction that the type defines that way (a match-pairs tile locking when its pair is right). The verdict and everything recorded still come from `grade`.

### The registry

```ts
export const CHALLENGE_COMPONENTS = {
	'multiple-choice': MultipleChoice,
	cloze: Cloze,
	'typed-translation': TypedTranslation,
	'match-pairs': MatchPairs,
	'multi-cloze': MultiCloze,
	'word-order': WordOrder,
	'spot-error': SpotError
} satisfies { [T in ChallengeType]: Component<ChallengeProps<T>> };
```

The mapped type keeps today's gate: a type added in Rust fails `pnpm check` here until it has a component. `ChallengeHost` replaces its `{#if}` chain with a lookup. The narrowing the chain gave is recovered the way `storedDefFor` already does it: the lookup is keyed by the challenge's own tag, so one cast inside the lookup is sound and nothing outside it is cast.

## One answer, end to end

1. The session picks a row and a help level (unchanged).
2. It asks Rust to serve the row: `serve(challenge, level)` returns `{ screen, audio, shown }`. The session warms `audio` for TTS.
3. The host renders the component with `screen`.
4. The learner commits; the component calls `onanswer(answer)`.
5. The session calls `grade(challenge, shown, answer)`, which is synchronous, and gets `Graded` plus `logged`, the `answerGiven` string.
6. The session passes `graded` back to the component, which shows its locked state, and to the feedback banner, which reads `feedback` and no longer looks up a def.
7. The session files the answer with `recordAnswer` (unchanged; `itemVerdicts` come from `Graded`).

Escalation (`describeShown`) reads the served `screen` and passes it to the model call, so it no longer branches on type.

## Gates

| Forgotten | What fails |
|---|---|
| A trait method, or a type in `challenge_types!` that does not implement the trait | `cargo build` |
| A kind's data, a step a kind lists that the type does not declare, a duplicate rank | the generic `type.json` tests |
| A component | `pnpm check` at the frontend registry's mapped type |
| Behaviour | the **conformance suite**, which runs on every registered type |

The conformance suite is new, and it is what makes a plugin trustworthy on its own. For each type and each of its kinds:

- `example` rows round-trip through JSON to the same value and pass `check_shape`.
- At every help level of every example: `screen` succeeds, `correct_answer` grades `correct`, and a wrong answer the suite builds from the screen grades `wrong`.
- `logged(correct_answer)` is non-empty, and `logged` matches a pinned string per type, which guards the event format.
- Each lesson fixture resolves, passes `check_shape`, and reads back as its kind.
- A row written at length *n* measures as *n* within the kind's range.
- Every step a row offers is one the type declares, and every help-level id round-trips.

## Migration

Slices by capability across all types, not type by type: converting one type at a time leaves half the `match`es converted. Each slice keeps every gate green, the golden fixtures untouched and the calibration fixtures unchanged, and is its own commit.

0. **Scaffold.** Add the trait with only `TAG`, `Stored` and `common`, and the macro generating `Challenge`, `ChallengeType`, `ALL`, `STORED_TYPES` and parsing. Move each stored struct into `types/<type>/mod.rs`. No behaviour change. *Done when* `challenge.rs` is gone and nothing else changed.
1. **Grading.** Add `Answer`, `grade`, `logged`, `Feedback`, `audio_texts` and `correct_answer`. Components send answers and stop grading; the banner reads `Feedback`; the frontend defs are deleted. A test replays every verdict-producing case from today's component and Rust tests through the new path. *Done when* no component calls `validateAnswer` or compares an index, `grade.rs`'s per-type `check` is gone, and there is one grading path.
2. **Showing.** Add `Screen`, `steps`, `has_readings`, `can_listen` and `screen`; steps become per-type strings. `Presentation`, the global `Step` enum and the per-type parts of `help.rs` and `serve.rs` go; components take their typed screen; `describeShown` reads the screen. *Done when* no generic module matches on a variant except `legacy.rs`.
3. **Writing.** Move the wire structs, resolvers and lesson JSON into the plugins; `sapling-llm` builds prompts and schemas from the registry. *Done when* `wire.rs` and the `source` match are gone and the mock lessons resolve every kind in both scenarios as today.
4. **Kinds and data.** Add `type.json` per type with ranks, lengths, written steps and starting numbers; `kinds.rs` becomes the generic view; `sim.rs` uses `example`. *Done when* `data/kinds.json` and the per-kind entries in `data/model.json` are gone and the simulated-learner and calibration tests pass unchanged.
5. **Frontend layout.** Move the components into `src/lib/challenges/types/<type>/` and the blocks into `src/lib/challenges/blocks/`; replace the `{#if}` chain with the registry lookup. *Done when* `routes/learn/` holds only the session pages and the banner.
6. **Contracts.** Rewrite `.claude/rules/challenges.md` around the plugin contract and cut the `add-challenge-type` skill down to the procedure below. Move the conformance suite's description into this document's Gates section as the contract.

Slices 1 and 2 are the largest and change the protocol between the window and the core. The rest are mostly moves.

## Adding a type, afterwards

1. `crates/sapling-challenges/src/types/<type>/`: the stored struct, `impl ChallengePlugin`, `type.json`, and a lesson JSON per kind with fixtures for both mock scenarios.
2. One line in `challenge_types!`.
3. `src/lib/challenges/types/<type>/<Type>.svelte`, drawing its `Screen` and sending its `Answer`.
4. One line in `CHALLENGE_COMPONENTS`.
5. `pnpm core:test` runs the conformance suite on it; `pnpm check` checks the registry; add a pooled row to the `broad` golden fixture.

## Decisions for the owner

These shape the slices. The recommendation comes first in each.

1. **Move the presentation facts to Rust.** *Recommended.* It makes the frontend half a component only, and the facts are pure functions of the row. The alternative keeps the defs in TypeScript beside each component: less protocol churn, but two files per type on the frontend and facts about the answer living apart from grading.
2. **Move generation (wire structs, resolvers, lesson specs) into the plugin.** *Recommended*, for real colocation. `sapling-challenges` gains a `schemars` dependency and holds prompt text as data, but still makes no model call. The alternative mirrors the plugin folders inside `sapling-llm` (`sapling-llm/src/types/cloze/`), keeping that crate the only one that knows what the model is told, at the cost of three folders per type.
3. **Keep match pairs as a plugin with no kinds.** *Recommended*: it is drawn, answered and logged like the others. The alternative is a separate drill outside the registry, which removes `REVIEWS` and `POOLED` from the contract but gives the session a second path.
4. **Keep the retired `translate-to-target` kind.** *Recommended* until you decide its future in the spec: existing rows still parse and resolve. Dropping it removes a kind and its lesson, and its rows would stop being served (they already are not).
