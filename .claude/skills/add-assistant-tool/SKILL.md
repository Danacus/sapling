---
name: add-assistant-tool
description: >
  Add a capability to Sapling's chat assistant — a new tool the LLM can call to
  read or change learner state. Use when asked to give the assistant/chat a new
  ability, add an assistant tool, or extend what the chat can do
  (e.g. "let the assistant set a daily goal", "add a search_words tool").
argument-hint: [tool_name]
---

# Adding an assistant tool

A tool is Rust: `crates/sapling-llm/src/tools.rs`. `assistant.md` is the
contract.

1. Add a `ToolName` variant and list it in `ToolName::ALL`, in the order the
   model should see it (reads before writes). **The gate:** `as_str`, `tool`
   and `execute` match exhaustively, so `cargo build` fails until all three name
   it. `ALL` is the membership — a variant left out of it is never offered to
   the chat.
2. Write its params struct (`Deserialize` + `JsonSchema`; optional arguments
   are `#[serde(default)] Option<T>` and stay optional — no strict sealing),
   its description in `prompts/tool-<name>.txt` (snake_case name on the wire,
   kebab-case file), and its executor `async fn <name>(params, ctx) ->
   StoreResult<ToolOutcome>`.
3. Test it in `tools.rs` against `MemoryTools`.

Conversation mode offers `add_words` only; don't add a new tool there unless
asked.

## If the tool needs more than the word list

`ToolContext` is deliberately narrow (all items, upsert, delete, new id, now).
Growing it is a chain the compiler walks you through: the trait, `MemoryTools`,
the wasm `ToolHost` (the `extern` block and the `typescript_custom_section`
interface in `crates/sapling-wasm/src/lib.rs`), then `pnpm check` fails at
`toolHost` in `src/lib/llm/core.ts` and `ToolContext` there, and
`src/lib/assistant/context.ts` wires the new method to a repository.

## Contracts

- **Never touch the store directly.** Every read and write goes through
  `ToolContext`, whose browser implementation is the repositories — that is what
  makes every change an event and syncs it.
- Anything creating vocabulary goes through `add_words`: `fsrsCard: null`, a
  real `introducedAt`, and the `same_card` dedupe. **`add_words` is the only
  way words enter the collection.**
- A domain failure is a **result** (`failure(...)`: `{error}`, `ok: false`) the
  model reads; only a `StoreError` ends the call.
- A turn is atomic: tool traffic is never replayed into later turns. Don't
  design a tool that needs to see its own earlier calls. The chat runs at most
  `MAX_TOOL_ROUNDS` rounds.

## Mock mode

`chat.rs`'s `mock` plays the model through the real loop: `term = meaning`
lines call `add_words`, a question about the list calls `list_words`. Extend it
if the tool should be reachable without a key; otherwise it is online-only.

## Completion criteria

- [ ] Variant, `ALL`, params struct, description file, executor, tests
- [ ] Every mutation goes through `ToolContext`
- [ ] `pnpm core:test`, `pnpm core:check`, `pnpm check`, `pnpm test` pass
- [ ] Exercised once in mock mode, or explicitly noted as online-only
