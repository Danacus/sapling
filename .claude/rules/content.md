---
paths:
  - "src/lib/romanize/**"
  - "src/lib/tts/**"
  - "static/tts/**"
---

# Romanization and speech

- `src/lib/romanize/` — **local, per-language romanization, no LLM**. The registry (`index.ts`) is keyed by BCP-47 primary subtag (resolved from the free-text `targetLanguage` via `$lib/tts/languages`' `bcp47For`; currently `zh` only — Cantonese maps to `yue` and is deliberately excluded, jyutping ≠ pinyin). `loadRomanizer` dynamic-imports the implementation so pinyin-pro's ~287KB dictionary is a lazy chunk only Chinese learners fetch; `romanizerFor` is the sync accessor once loaded. `zh.ts`'s correctness invariant: the **whole string** goes through pinyin-pro and readings are sliced per char — context is what resolves polyphones (银行 háng vs 自行车 xíng), so never romanize a term in isolation. `tokenize(text, terms)` groups characters around the learner's vocabulary `terms` so a tracked word comes back as one token whose `text` equals its item term. Consumption: `planReadings` (`$lib/session/romanization`, rolled once at serve) yields a `ReadingPlan` — `sentence` for flat stored readings, `byTerm` for per-word adaptive fading — and `rubyFor` in `$lib/challenges/props` is the one composition every challenge component calls; `blocks/RubyText.svelte` renders the tokens and stays dumb (hidden readings arrive already nulled by `applyPlan`). A `null` tokenizer (no local romanizer, or its chunk not landed yet) falls every slot back to the stored LLM `…Romanization` strings gated by `readings.sentence` — exactly the pre-ruby behavior, which is why the wire format keeps emitting readings: they are the fallback for every other language and feed the romanized `acceptedAnswers`.

- `src/lib/tts/` — public API `speak(text, lang)`; zh+en use Kokoro v1.1 via sherpa-onnx WASM, everything else Web Speech. **The worker is plain JS at `static/tts/sherpa-worker.js`, deliberately outside Vite** (a bundled TS worker diverged between dev and build); config reaches it via the init message from `sherpa.ts`, with `models.ts` the single source of truth for artifact URLs/sizes. Model files (~439MB fp32) are runtime-fetched from a pinned mirror commit and cached in Cache Storage; the int8 variant is a known upstream NaN/silence bug — don't "optimize" back to it. Audio failures must degrade silently to fallback; sound never blocks gameplay.
