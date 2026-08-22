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
  word in the dashboard and end-of-session lists. See [Speech](#speech) for the
  two engines and the trade-off between them.
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
src/lib/tts/          Text to speech: Kokoro-82M in the browser (lazily
                      imported, never in the entry chunk) with the Web Speech
                      API as fallback. Language→voice mapping and the audio
                      cache are pure and unit-tested.
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
| **Kokoro** (default) | [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) running locally in your browser via [`kokoro-js`](https://www.npmjs.com/package/kokoro-js) | English only — see below |
| **Browser built-in** | The Web Speech API and whatever voices your OS has | Everything else, always |
| **Off** | Silence | Buttons render disabled |

Nothing about speech can break a lesson: every failure — no voice, blocked
autoplay, a model that won't download — degrades to a `console.warn` and a
silent no-op.

### Kokoro is English-only here

`kokoro-js` ships voice tensors for nine languages, but the packaged library
registers **only its 28 English voices**, rejects any other voice id outright,
and hard-codes its phonemizer to `en-us`/`en-gb`. Feeding it Spanish or Chinese
would read that text with English phonemes and produce confident nonsense, so
the app doesn't: any non-English target language silently uses the Web Speech
API instead, which at least uses a voice actually trained for the language.
Settings says so explicitly when your target language isn't covered.

This applies to **Mandarin in particular**. Kokoro v1.1-zh exists and is good,
but its tokenizer expects Bopomofo (ㄅㄆㄇㄈ) plus tone digits from a Chinese
G2P frontend that `kokoro-js` does not have — and `kokoro-js` fetches its voice
files from the v1.0 repository regardless of which model id you pass. Supporting
it would mean bypassing `kokoro-js` entirely.

### Model download and caching

The first time Kokoro is used it downloads the model from Hugging Face:
**~90 MB** on the CPU path (`q8`), **~330 MB** on the WebGPU path (`fp32`).
Transformers.js caches every file in the browser's Cache Storage
(`transformers-cache`), so this happens once per browser profile and the app
then works offline. There is a **Preload voice model now** button in Settings
with a progress bar, so the download doesn't happen mid-lesson. Generated audio
is additionally kept in a small in-memory LRU for the session, so replaying a
word is instant.

Note that `pnpm build` emits onnxruntime-web's ~21 MB `.wasm` alongside the app.
It is only fetched when Kokoro actually runs, but the deployed directory is
large because of it.

### WebGPU, and the garbled-audio escape hatch

Kokoro runs on WebGPU when the browser exposes `navigator.gpu`, and on CPU
(WASM) otherwise. Settings shows which one you'll get. **WebGPU always uses
fp32** — fp16 is a known source of garbled Kokoro output on some GPU/driver
combinations.

Even so, some browsers' WebGPU implementations produce garbled audio. If that
happens, set **Kokoro runs on → CPU (WASM)** in Settings; it is slower but
correct. The loaded model is thrown away and rebuilt on the next tap.

Firefox on Linux does not enable WebGPU by default. If you want to try it,
set `dom.webgpu.enabled` to `true` in `about:config` — but this is exactly the
combination most likely to need the CPU fallback above.

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
