---
paths:
  - "src/lib/assistant/**"
  - "src/routes/chat/**"
  - "src/lib/conversation/**"
  - "src/routes/converse/**"
  - "crates/sapling-llm/src/tools.rs"
  - "crates/sapling-llm/src/chat.rs"
  - "crates/sapling-llm/src/conversation.rs"
---

# The chat assistant and conversation mode

Adding a tool is a procedure — the `add-assistant-tool` skill has it.

Both run in Rust (`crates/sapling-llm`: `tools.rs`, `chat.rs`, `conversation.rs`), through the `llm!` table (`sendChatMessage`, `startConversation`, `sendTurn`, `addWords`) and `callLlm`, like every other model call (`llm.md`, `core.md`). Prompts, tool descriptions and mock fixtures are data (`prompts/{chat,scenario,teacher*,tool-*}.txt`, `fixtures/{chat,conversation}.json`).

## The tools (`tools.rs`)

- **The host lends the word list.** `ToolContext` is a trait — all items, upsert items, delete item, new id, now — and nothing else a tool may touch. In the browser it is `$lib/assistant/context.ts`'s `defaultToolContext` over `$lib/db`'s repositories (the one module in `$lib/assistant` and `$lib/conversation` that imports the DB), handed to wasm as a `ToolHost` by `$lib/llm/core.ts`; `MemoryTools` is the in-memory one tests use. Every write therefore goes through the repositories and is an event. A call that runs tools without a context is a malformed call.
- **Four tools**, `ToolName::ALL` in the order the model sees them: `add_words`, `list_words`, `update_word`, `remove_word`. Each is a serde + `schemars` params struct (optionals stay optional — this is not a strict reply schema), a description in `prompts/tool-<name>.txt` and an executor. A call can only run a tool the loop offered.
- **A domain failure is a result**, `{error}` with `ok: false`, which the model reads and recovers from: an unknown tool, arguments that do not parse, no such word, an ambiguous homograph. Only the store failing ends the call (a plain `Error` in TypeScript).
- **`add_words` is the one route by which vocabulary enters the collection** — lesson generation writes challenges only, and reading mode's "Add to my words" is `addWords` from `$lib/assistant`, the same executor with no model. It mints items with `fsrsCard: null` (the core folds the card from `introducedAt`) and dedupes by **card**, not spelling (`same_card` in `text.rs`: same `term_key` and a reading that fails to tell them apart), against the list and within the batch. So 长 `cháng` and 长 `zhǎng` are two cards, while a word with **no** reading collides with every spelling of itself, and so does a stored card without one: nothing in a bare 长 says which 长 it is, and a careless call must not fork an SRS history on a guess.
- `update_word` refuses an edit that would land one card on another; it and `remove_word` take a top-level `romanization` to say which homograph, and an ambiguous term is a failure, never a guess — `remove_word` cannot be undone. `update_word` never touches the card or the history; `null` leaves a field alone, `""` clears `romanization`/`notes`.

## The chat (`chat.rs`)

`sendChatMessage`: the system prompt from the profile and the word count — the level it names is `level_for` that count (`llm.md`), never a stored level — all four tools, at most `MAX_TOOL_ROUNDS` (5) rounds; out of rounds with nothing said is `ROUND_LIMIT_REPLY`. **A turn is atomic**: tool traffic never outlives it — prior turns travel as prose (`ChatTurn`), each executed call is an action note. The history is ephemeral by design (`src/routes/chat/`). **The mock plays the model through the real loop**: `term = meaning` lines become an `add_words` call, a question about the list a `list_words` call, and the reply is written from the tool's actual result.

## Conversation mode (`conversation.rs`, `src/lib/conversation/`)

A role-played dialogue with a teacher, UI at `src/routes/converse/`. **Persisted the way reading mode persists texts** (`conversationStarted`, `turnAdded`, `conversationDeleted`; `docs/conversation-mode.md` §6a): append-only, three insert-or-ignore rules. **The unit of persistence is the exchange** — a learner message and the teacher turn that answered it, written together by the page, so a failed reply is never stored and history always ends on a teacher line; identity is `(conversationId, index)`. The Rust call speaks the stored shapes themselves (`sapling-domain`'s `ConversationScenario`, `ConversationLearnerTurn`, `ConversationTeacherTurn`, …), so a stored transcript is the history argument as is. **The pages own every write.**

- **The level is the library's.** A turn's teacher prompt — the level it names and `reply_length`, the hard shape of a reply — is `level_for` the size of the word list the `ToolContext` lends; the scene call lends none, so `ScenarioArgs` carries a `wordCount` the page counts when the learner presses start. Interests are gone: `about` is the one personalisation.
- **Two strict envelopes**: the scene (`startConversation` — setting and roles in the native language; teacher-first exactly when there is an opener, and one that will not parse is a `bad-response`, since there is nothing to play without roles) and the turn (`sendTurn` — `reply`, `translation`, `heard`, `correction`). A turn that will not parse is prose, which becomes the line; a broken envelope becomes `…`, never shown.
- **The one tool is `add_words`**, called only for a word the *learner* produced correctly. **Two rounds, and the last asks without tools**, so a model that spends its final round on a tool call still has to answer.
- **History replays as dialogue**: learner turns as typed, never corrected; teacher turns as the whole envelope, with `heard` and `correction` paired back from the learner message they were about — a bare line would teach the model the wrong contract once per turn.
- **Corrections never enter the spoken line**: `correction.corrected` is the learner's whole message rewritten as a `{text, reading}` line. **The script is not a reward for getting it wrong**: `heard` is their message written properly in the target script whenever they typed any of it otherwise, so a correct romanized message still gets the sentence under the bubble. The two are exclusive: a surviving correction already carries the sentence; a correction that matches what was typed — the script exactly, or the reading loosely (`same_romanization`: case, tone marks, apostrophes and spacing ignored) — is dropped and its line becomes `heard`; a `heard` identical to what was typed is dropped.
- **The mock** is one fixed Spanish ice-cream scene; `term = meaning` lines file words through the real tool, the second message gets a correction and the third a `heard` line, all through the real parser.
- **`diff.ts` is presentation and stays TypeScript**: it aligns `corrected` against what was typed into inline spans. Its unit is what the script delimits — Han, kana and the mainland South-East Asian scripts one character at a time (Hangul excluded), and `spanGap` joins spans by the same rule. When the learner typed Latin, `alignedForm` diffs against `corrected.reading`, loosened as above; **the loosening is scoped to the reading**: in the language's own spelling every mark counts. Design doc: `docs/conversation-mode.md`.
