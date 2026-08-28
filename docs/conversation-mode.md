# Conversation mode — design

Status: **spec, not implemented.** Written to be handed to an implementation
agent.

## 1. Why

Sapling currently teaches almost entirely through translation: every challenge
type asks the learner to map between the two languages. Conversation mode adds
the other half — comprehension, production under time pressure, and immersion —
by putting the learner in a role-played conversation with an LLM teacher.

It is the existing chat assistant (`src/lib/assistant/`) with a different system
prompt, a structured reply envelope, and a narrower tool set. The loop, the tool
registry, the `ToolContext` seam, the mock/real dispatch and the page layout are
all reused; nothing about them changes.

## 2. Shape of a session

1. **Start screen.** One optional free-form topic input ("ordering coffee",
   "arguing about football") and a Start button. Blank means "you choose".
2. **Scenario call.** One structured LLM call picks a setting, a role for the
   teacher, a role for the learner, and who speaks first. If the teacher speaks
   first it also emits the opening line.
3. **Scenario card.** Rendered at the top of the transcript: setting, "you are
   …", "I am …". In the learner's native language, so the setup is understood
   before the target language starts.
4. **Turn loop.** Learner writes in the target language → one teacher turn comes
   back → repeat. Ephemeral: no transcript is persisted, a reload starts fresh.
   The only thing that survives a session is vocabulary the teacher added.

## 3. The teacher's two jobs

**Keep the conversation going.** Reply in character, in the target language, at
the learner's level. Ask questions back; never let the exchange die.

**Correct — but only real mistakes.** A correction is a *language* error:
grammar, spelling, agreement, word choice, unnatural phrasing. It is never a
comment on what the learner said. If the learner asks for a pizza in an ice
cream shop, the teacher answers in fiction ("sorry, we only have ice cream") and
emits no correction. The rule has to be stated in the prompt with an example,
because this is the failure mode a model will fall into on its own.

Two rules do the work, and the second is the one that has to be spelled out. The
correction is about the language, never the content — that is the pizza rule
above. And it is the **smallest edit that keeps their meaning**: fix the wrong
word or ending, leave every other word as they wrote it, and keep what they said
even when it is odd, mistaken about the scene, or rude. Without that second
rule, "word choice" and "unnatural phrasing" become a licence to rewrite — a
learner saying *I am not your boss* gets back *I am not the boss here*, which
corrects nothing and silently changes who they were talking about. When in doubt
the correction is null.

Corrections never appear in the spoken reply. They travel in a separate field so
the app can mark them up quietly next to what the learner wrote, and the
conversation itself reads as a conversation.

## 4. Wire formats

Both are pinned with `responseFormat: { schema, name }` on `chatCompletion`,
which already coexists with `tools`. Cheap models sometimes reject structured
outputs and the client retries without them (`schemaDropped`), so the parser must
also accept a fenced or bare JSON body — reuse `stripFences` from `$lib/llm`.
Target-language strings carry their own Latin reading, exactly like the
`TargetText` primitive in generation: `{ text, reading }`, `reading: null` for
Latin-script languages.

Scenario:

```jsonc
{
  "setting": "An ice cream shop on a hot afternoon.", // native language
  "teacherRole": "the person behind the counter",     // native language
  "learnerRole": "a customer",                        // native language
  "firstSpeaker": "teacher" | "learner",
  "opener": { "text": "...", "reading": null } | null // non-null iff teacher first
}
```

Teacher turn:

```jsonc
{
  "reply": { "text": "Wat mag het zijn?", "reading": null },
  "translation": "What can I get you?",   // native language, hidden until tapped
  "correction": {
    "corrected": { "text": "...", "reading": null }, // their message, rewritten
    "note": "One word, and 'goeden-'."               // short native sentence, or null
  } | null
}
```

`corrected` is the learner's **whole message** rewritten, not a fragment — the UI
derives the marked-up spans itself by diffing it against what was typed — and it
carries a reading for the same reason the spoken line does, plus one more.

**A learner with no keyboard for the target script types the reading.** Pinyin,
romaji, a bare Latin approximation: on a non-Latin target this is the normal
case, not an edge case. Three things follow, and each of them is load-bearing:

- The prompt must declare romanized input legitimate — read phonetically, never
  corrected for being romanized — and must tell the teacher to *ask* when it
  cannot tell what was meant rather than answer a message it invented.
- `correction.corrected.reading` is the only side of a correction such a learner
  can be aligned against; `alignedForm` in `diff.ts` picks it when what they
  typed is *mostly* Latin-script and the corrected text is not. Mostly, not
  purely: real messages are mixed — someone typing pinyin pastes in the one
  character they know — and a single 主理人 in a line of romanization must not
  throw the alignment back onto the script.
- That comparison is loosened: tone marks folded (`foldDiacritics` from
  `$lib/validate`), case ignored, apostrophes dropped, and — as a whole-message
  test in `sameRomanization` — syllable spacing ignored, so a message that was
  right but spaced differently draws no correction at all. Where a syllable
  boundary falls in pinyin or romaji is a convention the learner cannot guess
  and the model applies inconsistently.

The loosening is scoped to the reading, and that scoping is the whole safety of
it. In the target language's own spelling every mark counts: French `ecole` for
`école` *is* the correction, and folding it would hide the mistake. Nothing here
touches a Latin-script target.

Schemas live in `src/lib/conversation/schemas.ts` as zod, projected to JSON
Schema with the existing `toJsonSchema`. Model-emitted optional fields are
`.nullish()` and normalized to absent on parse, per `docs`-wide convention.

`max_tokens` is set well clear of the worst case on both calls (2000), because
it is a ceiling and not a budget: an unused token is not billed, and the only
thing a tight limit buys is a reply that stops mid-envelope. Truncation is
prevented, not recovered from.

What is left is a model that writes the wrong thing, and prose and a broken
envelope degrade differently. Content that is not JSON *is* the spoken line — a
model that ignored the format still said something in character, so it becomes
`reply.text` with no translation and no correction. An envelope is not a line:
salvage `reply.text` (or a bare string `reply`, which is what a model writes
when `response_format` was dropped) if it is there, and otherwise fall back to a
language-neutral pause. The conversation must never break on a malformed turn,
and must never render the envelope.

## 5. Vocabulary

**In.** The learner's word list is rendered into the system prompt as compact
`term (romanization) = meaning` lines, capped at `MAX_CONTEXT_WORDS` (start at
200, most recently introduced first). The instruction is "prefer these words;
going beyond them is allowed when the scene needs it, but do not force new
vocabulary in". Put the static prompt text first and the word block last, so the
cacheable prefix stays stable across turns.

**Out.** The teacher gets exactly one tool: `add_words`, reused verbatim from
`$lib/assistant/tools` — so it dedupes by term key, initializes the FSRS card and
captures a sync event, identically to the generation path. It is called when the
learner *produced* a word that is not in their list and used it correctly; never
for words the teacher itself introduced. That is the point of the feature: the
list grows out of what the learner has actually shown they can use.

`list_words` is deliberately **not** exposed — the list is already in the prompt,
and a read round trip per turn is not worth paying for. `update_word` and
`remove_word` are not exposed at all; a role-play teacher has no business
deleting vocabulary.

## 6. Module layout

```
src/lib/conversation/
  index.ts        public surface: startConversation, sendTurn, the types
  scenario.ts     scenario prompt + parse + the one setup call
  teacher.ts      system prompt, the turn loop, reply parse
  schemas.ts      zod for both envelopes
  diff.ts         word-level diff of typed vs. corrected, for the markup
  mock.ts         the offline path
src/routes/converse/+page.svelte
```

`teacher.ts` mirrors `chat.ts`: it owns the loop, tool failures come back to the
model as `{error}` results, only `LlmError` escapes, and a turn is atomic. Two
deliberate differences from `chat.ts`:

- **`MAX_TOOL_ROUNDS = 2`, and the last round is asked without tools.** One
  tool, no read-then-write pattern. Offering the tool on every round lets a
  model spend the final round calling it, and the turn then ends with a tool
  result nobody asked about and no line for the learner — a pause the model
  never meant to take. Withdrawing the tool on the last round leaves answering
  as the only thing to do.
- **History replays as dialogue, not JSON.** Prior teacher turns go back as
  plain `assistant` messages carrying only `reply.text`; learner turns go back as
  what they actually typed, not the corrected version. The output contract is
  re-stated by the system prompt and pinned by `responseFormat` each turn, so the
  envelope never has to travel in the history.

Nothing in the module imports `$lib/db`; every side effect goes through the
injected `ToolContext`, same seam as the assistant.

## 7. UI

`src/routes/converse/+page.svelte`, modeled on `src/routes/chat/+page.svelte` —
same bubble/composer/error/retry structure, same ephemeral turn array in
`$state`. Copy the patterns; only extract a shared component if a piece comes
across unchanged, and do not refactor the chat page as part of this work.

- Scenario card pinned above the transcript.
- Teacher bubbles: target text, a `SpeakButton` (`$lib/ui/SpeakButton.svelte`,
  `lang={profile.targetLanguage}`), the reading underneath when present, and the
  translation behind a tap-to-reveal.
- Learner bubbles: what they typed. When a correction came back, the changed
  spans are marked inline (from `diff.ts`) with the note shown quietly
  underneath — visible, not modal, never interrupting the flow. When the markup
  ran against the reading, the corrected sentence in the target script is shown
  under it, since that script is the thing being learned.
  The correction arrives with the *next* teacher turn, so the learner's bubble
  updates in place when the reply lands.
- `add_words` calls surface as one subtle line, the same `ActionNote` treatment
  the chat page already gives them.
- Entry point: alongside the existing assistant link on the home page.

## 8. Mock mode

Node tests are always in mock mode and the whole app must stay developable
without a key, so `mock.ts` follows `assistant/mock.ts`: a fixed scenario, a
short cycle of canned teacher replies, a canned correction on a set turn, and —
so the tool path is genuinely exercised offline — a `term = meaning` line in the
learner's message routed through the real `executeToolCall`/`add_words`.
Deterministic: same input, same reply, same writes.

## 9. Tests

Node, pure logic, per `src/**/*.test.ts`:

- prompt building (word block capped and formatted, topic threaded through);
- both parsers: valid, nullish normalization, malformed-JSON fallback;
- `diff.ts`, including no-change and whole-message-rewritten;
- the turn loop against a fake `fetchFn` and an in-memory `ToolContext`: a plain
  turn, a turn with an `add_words` call, a tool failure, the round limit;
- mock determinism.

Green light is `pnpm check`, `pnpm test`, `pnpm format:check`.

## 10. Scope

Out: persisted transcripts, sync of conversations, voice input, auto-play TTS,
mid-conversation scenario switching, difficulty adaptation from conversation
performance. Each is additive later; none of them changes the shapes above.

Documentation to update on landing: `.claude/rules/assistant.md` (add
`src/lib/conversation/**` and `src/routes/converse/**` to `paths:`, plus one
bullet), and the architecture table row in `CLAUDE.md`.
