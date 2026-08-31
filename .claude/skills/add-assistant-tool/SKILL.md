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

`src/lib/assistant/tools/` is a registry in the house pattern. **Adding a
capability is one def module + one registration.**

1. Write `src/lib/assistant/tools/<tool-name>.ts` bundling its zod
   `paramsSchema` and its `run`.
2. Register it in `tools/index.ts`, which projects the client tool JSON
   (`toolDefsForClient`) and dispatches `executeToolCall`.

Tool names are snake_case on the wire (`add_words`, `list_words`), file names
are kebab-case (`add-words.ts`). Follow the existing four.

## Contracts

- **Never touch the DB directly.** Tools run against an injectable
  `ToolContext`, whose default is wired to `$lib/db` + `$lib/srs` in
  `tools/context.ts` — the only module here that may import the DB. Going
  through the repositories is what captures sync events for free; a direct store
  call silently breaks multi-device sync.
- Anything creating vocabulary must initialise FSRS cards via `$lib/srs` and
  dedupe with `sameCard` (`$lib/text`) — same spelling *and* a reading that
  fails to tell two cards apart — exactly as `add_words` does. **`add_words` is the only
  way words enter the collection** — lesson generation writes challenges and
  never items — so that dedupe is the app's single guard against a forked SRS
  history.
- Tool failures are **returned**, not thrown — `chat.ts` feeds `{error}` back to
  the model as a tool result so it can recover. Only `LlmError` escapes the loop.
- A turn is atomic: tool traffic is never replayed into later turns; prior turns
  travel as prose. Don't design a tool that needs to see its own earlier calls.
- The loop runs at most `MAX_TOOL_ROUNDS` rounds. A capability needing more
  round-trips than that is the wrong shape.

## Mock mode

`assistant/mock.ts` parses `term = meaning` lines and drives the **real**
executors, so the offline path exercises real code. If the new tool should be
reachable without an API key, extend the mock's parsing — otherwise it is
simply unavailable offline, which is usually fine.

## Completion criteria

- [ ] Def module written and registered in `tools/index.ts`
- [ ] Every mutation goes through `ToolContext`, not the store directly
- [ ] `pnpm check` and `pnpm test` pass
- [ ] Exercised once in mock mode, or explicitly noted as online-only
