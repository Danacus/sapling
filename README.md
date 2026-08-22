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
src/lib/ui/           Shared presentational bits (spinner, progress bar).
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
