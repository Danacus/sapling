# Language Learning

A gamified, local-first language-learning web app. Pick a language you speak, a
language you want, a few things you're interested in — and the app writes you a
personalized lesson, grades it, and schedules what you should see again and
when.

It is a single-page app with no backend. Your profile, your vocabulary and your
progress live in your browser's IndexedDB. The only thing that ever leaves the
device is one compact prompt per lesson batch, sent straight from your browser
to [OpenRouter](https://openrouter.ai) with your own API key.

## Features

- **Four challenge types.** Multiple choice, cloze (fill the blank, with a
  tappable word bank when it helps), typed translation, and match-pairs.
- **Content written for you.** Challenges are generated from your level, your
  interests and — crucially — the exact words your spaced-repetition schedule
  says you are about to forget.
- **Per-session topics.** Before a session starts you can name a scenario —
  "ordering in a restaurant", "asking for directions" — and that batch's
  dialogue leans into it; leave it blank to just review. Recent topics and a
  handful of suggested ones (plus a couple drawn from your interests) are
  offered as chips, and the last few you typed are remembered on the device.
  If you quit a session early, `/learn` opens to a small choice instead: keep
  going on the leftover queue (no new topic, no refill — it just plays out),
  or clear it and pick a new topic.
- **Romanization for non-Latin scripts.** Learning Mandarin, Japanese or
  another language not written in the Latin alphabet gets you a pinyin/romaji
  reading under every target-script string — prompts, options, sentences and
  match-pairs tiles alike — with nothing to configure. Latin-script languages
  never see the field at all. Turn it off in Settings if you don't want it.
- **Hear it.** Speaker buttons sit next to every bit of target-language text —
  prompts, cloze sentences, the correct answer on the feedback banner, and every
  word in the dashboard and end-of-session lists. Mandarin and English get a
  real neural voice (Kokoro v1.1-zh, in your browser); everything else uses your
  system voices. See [Speech](#speech).
- **Forgiving grading.** A missing accent or a one-character typo is graded
  "almost", counted as correct, and shown the right form. Grading is local,
  instant and free.
- **Ask why.** Every graded answer has an *Explain* button. Type your own
  question (or dispute the grade — "I think I was right" works) and get a short,
  targeted answer. This is the only thing that spends tokens mid-session, and
  only when you ask.
- **FSRS scheduling.** Real spaced repetition via
  [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs), not a
  homegrown interval table.
- **Game feel.** XP, combo streaks with a bonus that ramps, a daily goal, a day
  streak, segmented session progress, and a confetti finish. Every animation
  respects `prefers-reduced-motion`.
- **Practice mode.** The whole app is playable with no API key at all, against a
  deterministic offline fixture. Good for a look around, and for development.
- **Your data is yours.** Export and import everything as JSON from Settings.

## Quickstart

The repo ships a Nix flake with the exact toolchain.

```sh
nix develop          # enter the dev shell (node + pnpm)
pnpm install
pnpm dev             # http://localhost:5173
```

Without Nix, any Node 22+ with pnpm will do — `pnpm install && pnpm dev`.

Other scripts:

```sh
pnpm test            # vitest, node environment, pure-logic unit tests
pnpm check           # svelte-check + tsc
pnpm build           # static production build into build/
pnpm preview         # serve the production build
```

### Practice mode (no key needed)

With no API key configured the app runs in **practice mode**: lessons come from
a built-in Spanish-for-English-speakers fixture, explanations are canned, and
nothing is sent anywhere. The session screen shows a small banner so you always
know which mode you are in. It exercises the real parse/resolve/grade code path,
so it is a faithful preview — just not personalized.

### Using your own OpenRouter key

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open **Settings** in the app, paste it, and pick a model.

The key is stored in `localStorage` on that device only. It is deliberately
excluded from exports, and there is no server that could see it. The default
model is a cheap, fast one (`google/gemini-2.5-flash-lite`); anything on
OpenRouter that can follow a JSON schema will work.

## Architecture

```
src/lib/types.ts      Domain types. Dependency-free; everything imports it.
src/lib/db/           Dexie/IndexedDB. Repositories are the only sanctioned
                      way to touch storage. Device secrets live in
                      localStorage (settings.ts), never in the database.
src/lib/srs/          Spaced repetition (ts-fsrs). Pure and deterministic:
                      `now` is always a parameter, never `Date.now()`.
                      The single place `KnowledgeItem.fsrsCard` is cast.
src/lib/validate/     Fuzzy answer grading. Unicode-aware normalization plus
                      Damerau-Levenshtein, producing correct/almost/wrong.
src/lib/llm/          OpenRouter client, batch generation, escalation, and the
                      offline mock. Touches no database.
src/lib/session/      Session rules: refill planning, XP/combo, applying an
                      answer. The bridge between the four modules above.
src/lib/tts/          Text to speech: Kokoro v1.1-zh running in a Web Worker on
                      the sherpa-onnx WASM runtime, with the Web Speech API as
                      fallback. Language→voice mapping, the audio cache, the
                      WAV encoder and the artifact URLs are pure and
                      unit-tested; the worker is the only impure part.
src/lib/ui/           Shared presentational bits (spinner, progress bar,
                      speaker button) plus lightweight display preferences in
                      localStorage (romanization toggle, recent session
                      topics).
src/routes/           Dashboard, onboarding, settings, and the session screen
                      (`/learn`) with its four challenge components.
```

### The token economy

Generating one challenge at a time would be both slow and expensive. The design
instead concentrates spending into rare, batched calls and does everything else
locally.

- **Batched generation.** One `getBatch` call produces a whole lesson: ~14
  challenges plus a few new vocabulary items, from a ~480-token system prompt
  that never changes (so it caches well) and a compact JSON user message.
  Roughly **2.5k tokens per batch** — a fraction of a cent on a small model.
  The queue is only topped up when fewer than five challenges are left.
- **Local grading.** Every answer is graded in the browser by
  `$lib/validate` — no judge call, no latency, no cost. The three-way verdict is
  what lets "café" typed as "cafe" be accepted *and* corrected.
- **Zero-token rounds.** Match-pairs challenges are assembled locally from words
  you already know. They cost nothing and are slotted in after every fourth
  generated challenge to vary the rhythm.
- **On-demand escalation.** A second model call happens only when you press
  *Explain*, and it carries just that one challenge, your answer and your
  question — a few hundred tokens, capped at a 120-word reply.
- **Salvage over retry.** A malformed challenge in a batch is dropped, not the
  whole batch you already paid for. Only an unusable envelope triggers a single
  corrective retry.

Two consequences worth knowing: match-pairs rounds pay a flat 5 XP and
deliberately do **not** feed the scheduler (they are recognition drills built
from known words, so letting them grade would inflate your recall estimates),
and a session banks its XP in a single write at the end — including when you
quit early, so partial progress is never lost.

### XP and combos

| Verdict  | Base XP |
| -------- | ------- |
| correct  | 10      |
| almost   | 8       |
| wrong    | 0       |

From a combo of 3 consecutive non-wrong answers, each answer earns a bonus of
`2 × (combo − 2)`, capped at +10 — so combo 3 pays +2, combo 7 and beyond pay
+10. A wrong answer scores nothing and resets the combo. Match-pairs rounds pay
a flat 5 XP and leave the combo untouched.

## Speech

Tap the 🔊 next to any target-language string and it is read aloud. Two engines,
chosen in **Settings → Speech**:

| Engine | What it is | When it's used |
| --- | --- | --- |
| **Kokoro (neural)** (default) | [Kokoro v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) running locally in a Web Worker on the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WebAssembly runtime | Mandarin and English |
| **Browser built-in** | The Web Speech API and whatever voices your OS has | Every other language, always |
| **Off** | Silence | Buttons render disabled |

Nothing about speech can break a lesson: every failure — no voice, blocked
autoplay, a model that won't download, a worker that dies — degrades to a
`console.warn` and a silent no-op, or falls back to the browser voice.

### What it actually covers

Kokoro v1.1-zh is a Mandarin + English model: 100 Mandarin speakers and three
English ones. sherpa-onnx supplies the Chinese frontend the model needs — a
lexicon plus a phrase matcher for word segmentation — alongside espeak-ng for
English, so **sentences that mix the two are handled in one pass** ("我买了 3 个
apple" comes out right).

Everything else routes to the Web Speech API, which at least uses a voice
trained for the language. Cantonese and Traditional Chinese are deliberately
*not* claimed: the model is Mandarin in Simplified script.

**Voices.** Settings offers three of the hundred Mandarin speakers (`zf_001`
female by default, plus `zf_018` and `zm_010`) under `ll.ttsVoice`. English
always uses `af_maple`, or `bf_vale` when your target language is British
English. The choice only applies to Mandarin — an English phrase read by a
Chinese speaker id would be exactly the wrong thing for a pronunciation aid.

### What downloads, from where

Two files, fetched on first use and stored in Cache Storage under
`ll-tts-models`:

| File | Size |
| --- | --- |
| `sherpa-onnx-wasm-main-tts.wasm` | 11.9 MB |
| `sherpa-onnx-wasm-main-tts.data` (the whole model) | 426.7 MB |

**≈439 MB, once per browser profile**, after which the app works offline. There
is a **Preload voice model now** button in Settings with a byte-accurate
progress bar so the download does not happen mid-lesson. Generated audio is
additionally kept in a small in-memory LRU for the session, so replaying a word
is instant.

The files come from a prebuilt sherpa-onnx WASM pack on the Hugging Face Hub
([`jiangzhuo9357/sherpa-onnx-tts-models`](https://huggingface.co/datasets/jiangzhuo9357/sherpa-onnx-tts-models),
directory `wasm-kokoro-fp32`), pinned to one immutable commit — the `.data` file
is an Emscripten file-package whose byte offsets are baked into the loader JS
vendored in `static/tts/`, so the two must never drift apart. Each download is
size-checked against the exact expected byte count before it is used, and a
cached copy that fails the check is deleted rather than trusted.

### Why 439 MB and not 227 MB

There is a half-size int8 build of the same model. **It does not work**: every
published int8 Kokoro WASM pack returns all-`NaN` samples from ONNX inference,
which reaches your ears as silence. That is
[sherpa-onnx#2236](https://github.com/k2-fsa/sherpa-onnx/issues/2236), it is not
fixed by building from source, and it was reproduced here in Firefox before
switching to the full-precision pack. So the app pays for fp32 and gets sound.

### CPU only, and no special hosting

sherpa-onnx's WASM build is single-threaded SIMD on the CPU. There is no WebGPU
path, and none is needed for single words and short sentences — expect roughly
a second or two per phrase on a laptop, off the main thread so the UI never
stalls. Because the build uses no threads it needs no `SharedArrayBuffer` and
therefore **no COOP/COEP headers**: the production build still deploys to any
dumb static host.

There is no longer a "runs on" setting (the old `ll.ttsDevice` preference is
left readable but unused), and the old Firefox/WebGPU garbled-audio caveat is
gone with it.

## Deploying

The app builds to a fully static SPA (`@sveltejs/adapter-static` with an
`index.html` fallback, SSR off).

```sh
pnpm build     # → build/
```

Upload `build/` to any static host — GitHub Pages, Netlify, Vercel, Cloudflare
Pages, S3, or `python -m http.server` in that directory. The only requirement is
the usual SPA rewrite: serve `index.html` for unknown paths so client-side
routes resolve. There is nothing to configure server-side, no environment
variables and no secrets in the bundle — the API key is supplied by each user in
their own browser.

The build itself is small (well under a megabyte, plus ~140 KB of vendored
speech-runtime JS in `static/tts/`). The speech model is *not* part of it: it is
fetched from the Hugging Face Hub at runtime, so your host never serves those
439 MB. No cross-origin-isolation headers are required either — see
[Speech](#speech).
