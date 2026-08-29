# Sapling

A local-first language-learning web app. Pick a language you speak, a language
you want, a few things you're interested in — and the app writes you a
personalized lesson, grades it, and schedules what you should see again and
when.

Vocabulary grows out of **talking**: you meet new words in a role-played
conversation with an LLM teacher, or ask the assistant for some, and the drill
sessions then review what you already have. Lessons never introduce a word.

It is a single-page app that works with no server at all. Your profile, your
vocabulary and your progress live in your own browser, in a SQLite database
(LiveStore, compiled to WebAssembly). What leaves the device is one compact
prompt per lesson batch (and one per conversation turn), sent straight from your
browser to [OpenRouter](https://openrouter.ai) with your own API key.

> The repo and package are still named `language-learning` / `language-app`;
> the app is Sapling.

## Features

- **Conversation mode.** Name a scenario — "ordering coffee", "arguing about
  football" — or leave it blank and let the model pick one. It casts you both in
  roles and you talk, in the target language. The teacher stays in character and
  corrects only *language* mistakes, never what you said: ask for a pizza in an
  ice cream shop and you get "sorry, we only have ice cream", not a correction.
  Corrections arrive quietly beside your own message with the changed words
  marked inline, never inside the reply. Words **you** produced correctly and
  didn't have yet are added to your collection — that is where vocabulary comes
  from.
- **Type the reading if you have no keyboard for the script.** On Mandarin or
  Japanese you can write pinyin or romaji and be understood; it is read
  phonetically and never "corrected" for being romanized. Every turn you get
  right still shows your own sentence in the real script, with a speaker button
  — the script is not a reward for getting it wrong.
- **Six challenge types.** Multiple choice, cloze (fill the blank, with a
  tappable word bank when it helps), typed translation, match-pairs, word-order,
  and spot-the-error.
- **Content written for you.** Challenges are generated from your level, your
  interests and — crucially — the exact words your spaced-repetition schedule
  says you are about to forget. A lesson is written *about* the vocabulary you
  already have and introduces none of its own.
- **Difficulty that follows the word, not the clock.** A new word is shown for
  recognition; production is unlocked per-word once you've actually recalled it
  a few times, so you are never asked to produce something you only just met.
- **Per-session topics.** When you generate a lesson you can name a scenario —
  "ordering in a restaurant", "asking for directions" — and that batch leans
  into it; leave it blank to just review. Recent topics and a handful of
  suggested ones (plus a couple drawn from your interests) are offered as chips,
  and the last few you typed are remembered on the device.
- **Starting is instant, generating is deliberate.** Every challenge ever
  generated stays in a persistent pool, and starting a session only plans over
  it — no network call, no waiting, ever. *Generate new lesson* is a separate
  button that spends one batched call in the background while you are already
  playing. Answering doesn't consume a challenge, so quitting early is
  self-cleaning: what you never saw simply comes back in the next plan.
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
- **Say it.** Conversation mode has a mic button: speak, and the transcript
  lands in the composer for you to edit and send. It is an input method, not a
  grader — nothing scores your pronunciation, and where the browser has no
  recognition for your target language the button simply isn't offered and you
  type instead.
- **A chat assistant.** `/chat` is an LLM that manages your vocabulary through
  tool calls — add words, look them up, edit or remove them — in plain language.
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
- **The Garden.** `/words` is the full vocabulary ledger with the FSRS state
  made legible — what each word's stability and due date actually are, and a way
  to forget one outright.
- **A day streak, and nothing else to score.** There is no XP, no combo bonus
  and no daily goal; the streak is *derived* from the results log rather than
  stored as a counter, so it can't drift. The
  dashboard states a moment ("N words ready to review") rather than grading your
  day. Segmented session progress and a confetti finish remain, and every
  animation respects `prefers-reduced-motion`.
- **Practice mode.** The whole app is playable with no API key at all, against a
  deterministic offline fixture. Good for a look around, and for development.
- **Your data is yours.** Export and import everything as JSON from Settings.

## Quickstart

The repo ships a Nix flake with the exact toolchain (Node 22, pnpm, and the
language servers) plus an `.envrc`, so [direnv](https://direnv.net) loads the
dev shell automatically on `cd`.

```sh
nix develop          # or just `cd` in, with direnv
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
pnpm format          # prettier --write .
pnpm format:check    # prettier --check .
```

### Practice mode (no key needed)

With no API key configured the app runs in **practice mode**: lessons, chat
replies and conversation turns all come from built-in fixtures, and nothing is
sent anywhere. The session screen shows a small banner so you always know which
mode you are in. It exercises the real parse/resolve/grade code path, so it is a
faithful preview — just not personalized.

There are two fixture sets, chosen by your target language: **Spanish for
English speakers** by default, and **Mandarin for English speakers** if you name
Chinese in onboarding — the latter carries pinyin on every target-script string,
so the romanization UI can be seen without spending a token. Both cover every
wire type. Node tests are always in mock mode.

### Using your own OpenRouter key

1. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open **Settings** in the app, paste it, and pick a model.

The key is stored in `localStorage` on that device only, and is deliberately
excluded from exports. The default model is a cheap, fast one
(`google/gemini-3.7-flash`); anything on OpenRouter that can follow a JSON
schema will work.

## Architecture

```
src/lib/types.ts      Domain types. Dependency-free; everything imports it.
src/lib/db/           Repositories: the only sanctioned way to touch storage,
                      and every write is an event. Also the read-only Dexie
                      remnant, kept solely so an old database can still be
                      migrated. Device secrets live in localStorage
                      (settings.ts), never in the database.
src/lib/srs/          Spaced repetition (ts-fsrs). Pure and deterministic:
                      `now` is always a parameter, never `Date.now()`.
                      The single place `KnowledgeItem.fsrsCard` is cast.
src/lib/validate/     Fuzzy answer grading. Unicode-aware normalization plus
                      Damerau-Levenshtein, producing correct/almost/wrong.
src/lib/challenges/   The stored side of the challenge union: one module per
                      type carrying its schema, its grading rule, its
                      difficulty tier and its presentation facts. The registry
                      is a mapped type, so a new member fails typecheck.
src/lib/llm/          OpenRouter client, batch generation, escalation, and the
                      offline mock. Stateless — touches no database.
src/lib/session/      Session rules: planning over the pool, per-word
                      difficulty progression, applying an answer. Owns every
                      DB write during play.
src/lib/assistant/    The chat assistant: an LLM managing learner state through
                      tool calls, against an injectable ToolContext.
src/lib/conversation/ Conversation mode on the same seam — scenario call,
                      teacher turn loop, and the typed-vs-corrected diff that
                      produces the inline markup. Imports no database.
src/lib/livestore/    The data layer. An append-only eventlog is the source of
                      truth; the SQLite tables are a projection of it, produced
                      by materializers. Also the one-time migration that turns
                      an old Dexie database into that log.
src/lib/romanize/     Local pinyin/romaji readings. Never romanizes a term in
                      isolation — context resolves polyphones.
src/lib/asr/          Speech recognition for the conversation composer. An
                      input method; the fallback is typing.
src/lib/tts/          Text to speech: Kokoro v1.1-zh running in a Web Worker on
                      the sherpa-onnx WASM runtime, with the Web Speech API as
                      fallback. Language→voice mapping, the audio cache, the
                      WAV encoder and the artifact URLs are pure and
                      unit-tested; the worker is the only impure part.
src/lib/ui/           Shared presentational bits (spinner, progress bar,
                      speaker button) plus lightweight display preferences in
                      localStorage (romanization toggle, recent session
                      topics).
src/routes/           Dashboard, onboarding, settings, the Garden (`/words`),
                      the assistant (`/chat`), conversation mode
                      (`/converse`), and the session screen (`/learn`) with its
                      six challenge components.
```

### The token economy

Generating one challenge at a time would be both slow and expensive. The design
instead concentrates spending into rare, batched calls and does everything else
locally.

- **Batched generation.** One `getBatch` call produces a whole lesson — up to
  20 challenges, written about vocabulary you already have — from a static
  system prompt (so it caches well) and a compact JSON user message. Roughly
  **2.5k tokens per batch**, a fraction of a cent on a small model. It is
  spent only when you press *Generate new lesson*; the start card nudges you
  when the pool runs low, but nothing generates behind your back.
- **Local grading.** Every answer is graded in the browser by
  `$lib/validate` — no judge call, no latency, no cost. The three-way verdict is
  what lets "café" typed as "cafe" be accepted *and* corrected.
- **Zero-token rounds.** Match-pairs challenges are assembled locally from words
  you already know. They cost nothing and are spliced into the queue at plan
  time to vary the rhythm.
- **On-demand escalation.** A second model call happens only when you press
  *Explain*, and it carries just that one challenge, your answer and your
  question — a few hundred tokens, capped at a 120-word reply.
- **Salvage over retry.** A malformed challenge in a batch is dropped, not the
  whole batch you already paid for. Only an unusable envelope triggers a single
  corrective retry.

- **Conversation costs one call per turn.** The teacher's reply, its
  translation, any correction and the sentence in the target script all come
  back in a single structured envelope, so a turn is one request and not four.
  Your word list rides in the cacheable part of the prompt, capped at the 200
  most recently introduced.

One consequence worth knowing: match-pairs rounds deliberately do **not** feed
the scheduler. They are recognition drills built from words you already know, so
letting them grade would inflate your recall estimates.

### What isn't scored

There is no XP, no combo multiplier and no daily goal — all three were removed.
A verdict is evidence about a *word*, and its only consumer is FSRS; grading is
deliberately blind to which challenge type produced it, because what difficulty
shapes is the question stream, never what an answer is worth. The one number the
app still keeps is the day streak, and it is folded out of the results log on
read rather than stored — which is also why it would survive a multi-device
merge without a rule of its own.

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

## Sync

**Optional, and off unless you set it up.** Out of the box Sapling is
single-device: everything lives in your browser and nothing is uploaded. Export
and import from Settings still works and needs no server at all.

If you deploy the sync backend (`worker/` — a Cloudflare Worker, one Durable
Object per learner, comfortably inside the free plan), Settings grows a **Sync**
section. Turning it on mints a **pairing phrase**; typing that phrase on another
device joins it to the same library. There are no accounts and no sign-up: the
phrase *is* the credential, and the Worker names your private room by hashing
it. Treat it like a password.

The hard part — making two devices converge without asking you to resolve
conflicts — is settled by construction rather than by the server. Every change
is an event appended to a log, and the SQLite tables you read are a projection
of it, so the backend only has to put events in an order and hand them back; it
never merges and never looks inside one. Reviews of the same word on two devices
are both kept and the FSRS card recomputed from the merged history; results are
a set-union; the day streak is derived from those results and needs no merge
rule at all. Sync failures degrade silently, so the app stays fully usable
offline, with the server down, or with sync switched off mid-life.

[`docs/livestore-sync.md`](docs/livestore-sync.md) is the architecture and the
setup runbook; [`docs/sync.md`](docs/sync.md) keeps the original design
reasoning, and the merge rules it argued out are still the ones enforced in
`src/lib/livestore/`.

## Deploying

The app builds to a fully static SPA (`@sveltejs/adapter-static` with an
`index.html` fallback, SSR off).

```sh
pnpm build     # → build/
```

Upload `build/` to any static host — GitHub Pages, Netlify, Vercel, Cloudflare
Pages, S3, or `python -m http.server` in that directory. There is nothing to
configure server-side, no environment variables and no secrets in the bundle —
the API key is supplied by each user in their own browser.

Two rewrite rules, and the second one matters more than it looks. The usual SPA
fallback serves `index.html` for unknown paths so client-side routes resolve —
**except** under `/_app/immutable/*`, where a missing hashed chunk must return a
real 404. `static/_headers` caches that prefix as immutable, so a request for a
dead chunk that falls through to the HTML shell gets edge-cached as a successful
response and poisons that URL for up to a year. `static/_redirects` and
`static/404.html` encode both rules for Cloudflare Pages; on another host you
have to reproduce them.

The app is also an installable PWA (`static/manifest.webmanifest` plus a service
worker registered in production builds only) — installable from the browser's
"Install app" control, or on iOS via Share → Add to Home Screen.

The build itself is small (well under a megabyte, plus ~140 KB of vendored
speech-runtime JS in `static/tts/`). The speech model is *not* part of it: it is
fetched from the Hugging Face Hub at runtime, so your host never serves those
439 MB. No cross-origin-isolation headers are required either — see
[Speech](#speech).
