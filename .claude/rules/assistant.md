---
paths:
  - "src/lib/assistant/**"
  - "src/routes/chat/**"
---

# The chat assistant

Adding a tool is a procedure — the `add-assistant-tool` skill has it.

- `src/lib/assistant/` — the chat assistant: an LLM that manages learner state through **tool calls** (the app's own miniature MCP), UI at `src/routes/chat/+page.svelte` (ephemeral history by design). `tools/` is another registry in the house pattern — one module per tool (`add_words`, `list_words`, `update_word`, `remove_word`) bundling its zod `paramsSchema` and `run`, with `tools/index.ts` projecting the client tool JSON (`toolDefsForClient`) and dispatching `executeToolCall`; **adding a capability is one def module + one registration** (the `add-assistant-tool` skill has the contracts). Tools run against an injectable `ToolContext` whose default is wired to `$lib/db` + `$lib/srs` in `tools/context.ts` — the only module here that touches the DB — so every mutation goes through the repositories and therefore captures sync events for free; `add_words` initializes FSRS cards and dedupes by term key exactly like the engine's generation path. `chat.ts` owns the loop (`sendChatMessage`: system prompt from profile + word count, at most `MAX_TOOL_ROUNDS` rounds, tool failures fed back to the model as `{error}` results rather than thrown; only `LlmError` escapes). A turn is atomic: tool traffic is never replayed into later turns — prior turns travel as prose. Mock mode (`mock.ts`) parses `term = meaning` lines and drives the *real* executors, so the offline path exercises real code.
