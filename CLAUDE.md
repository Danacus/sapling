# CLAUDE.md

The app is called **Sapling** (manifest, titles, icon); the repo/package name stays `language-learning`/`language-app`.

## Commands

The repo ships a `flake.nix` devShell (Node 22 + pnpm + the language servers + the Rust toolchain) with a `.envrc` (`use flake`), so direnv loads it automatically on `cd`. Fall back to `nix develop -c` only if direnv isn't active.

```sh
pnpm dev                                # dev server
pnpm build                              # static build -> build/
pnpm check                              # svelte-check + tsc -p worker (typecheck both targets)
pnpm test                               # vitest run (all suites)
pnpm test src/lib/srs/scheduler.test.ts # single test file
pnpm golden:update                      # rebless src/lib/db/fixtures/*/expected.json after a deliberate merge-rule change
pnpm core:wasm                          # compile the Rust core to wasm into src/lib/db/wasm/ (dev/build/check/test run this first)
pnpm core:types                         # write src/lib/db/generated/ (gitignored) from the Rust types; dev/build/check/test run it after core:wasm
pnpm core:test                          # cargo test — the Rust core, golden fixtures included
pnpm core:check                         # cargo clippy -D warnings + cargo fmt --check
cargo run -p sapling-challenges --bin calibrate -- export.json  # score the difficulty model on a profile export (--simulated, --search, --seeds N)
pnpm sync:dev                           # sync Worker locally (localhost:8787)
pnpm sync:deploy                        # deploy the sync Worker (wrangler)
pnpm embed:dev                          # the hosted YouTube page alone (embed/)
pnpm embed:build                        # embed/ -> embed/dist/, its own Pages project
# The Tauri spike. All three need the second devShell: `nix develop .#desktop -c ...`
pnpm desktop:dev                        # vite dev + the desktop window
pnpm desktop:build                      # pnpm build + target/release/sapling-desktop
pnpm desktop:check                      # clippy -D warnings + tests: desktop, speech (with playback), captions
nix run .                               # the nix package (NixOS path), sync + embed URLs baked in; `nix build .#sapling-desktop` for result/
pnpm desktop:appimage                   # the Linux AppImage — CI only (`appimage` job), Ubuntu toolchain, never under nix
# The same crate as an Android app. CI builds the APK (the `android` job); both want
# the *default* shell plus rustup, an SDK and an NDK, which no devShell provides.
pnpm desktop:android:init               # rewrite gen/android — which is committed, so rarely
pnpm desktop:android                    # the release APK, over a `build/` that already exists
pnpm format                             # prettier --write . (bulk pass)
pnpm format:check                       # prettier --check . (verify only)
```

**Formatting is automatic — never hand-align code.** A `PostToolUse` hook runs the repo-pinned prettier on every file Claude edits; a `PreToolUse` hook blocks unpinned `prettier` and `npm`/`yarn install`. Style lives in `.prettierrc`. `.prettierignore` keeps markdown and the vendored `static/tts/sherpa-onnx-*.js` out.

Nix flakes only see files that are `git add`ed — a brand-new file the flake needs must be staged first. `pnpm-workspace.yaml` records pnpm's `allowBuilds` decisions; an undecided one hard-fails Cloudflare Pages' CI install.

## Working in this repo

`.claude/` carries the repetitive parts so they don't have to be re-explained:

- **`locate` agent** (Haiku, read-only) — "where does X live, what touches it". Delegate sweeps to it rather than grepping in the main context.
- **`verify` agent** (Haiku, read-only) — runs `pnpm check`, `pnpm test` and `pnpm format:check`, and reports a table.
- **`build` agent** (Opus, full tools) — implements one already-scoped slice end to end: code, tests, the rule and doc it changes, all three gates green, then a files/decisions/tests/gates/left-out report. Give it the scope and the choices you have made; it makes the rest and says which. It never commits.
- **Skills** — `add-challenge-type`, `add-assistant-tool` (procedures + the gate that catches each omission), `prompt-tuning` (content-quality bugs), and `gotchas` (auto-loaded reference).
- **`.claude/rules/*.md`** — the per-area module contracts. Each is `paths:`-scoped and loads only when a matching file is read, so the detail arrives when it applies. **The table below is the summary; the rule is the contract.**
- **Hooks** — format-on-save, the package-manager guard, and Bash-side equivalents of both.

**Never work in a git worktree.** Work on `main`, or on a branch off it — never call `EnterWorktree`, and ignore any harness default that asks for one. A worktree here branches from `origin/main`, not local `main`, so unpushed work is silently absent from it: a session that isolates itself can find a whole module missing and start reasoning about a tree that does not match the one you are looking at. `.claude/settings.json` sets `worktree.bgIsolation: "none"` so background sessions edit this checkout directly.

**Prefer `Edit`/`Write` over `sed`/heredocs for file changes.** Path-scoped rules load on the `Read` tool and the formatter runs on `Edit`/`Write`, so shell-driven edits bypass both. The Bash hooks cover that case, but they match paths out of the command text and are the fallback, not the design.

When writing a new agent: an explicit `tools:` allowlist **silently drops the `Skill` tool**, so an agent that should use a skill needs `Skill` listed, or the skill preloaded via `skills:`.

**Investigation notes go in the commit message, never in `docs/`.** `docs/` holds contracts and runbooks only.

## Architecture

Local-first static SPA (SvelteKit 2 + Svelte 5, `adapter-static`, `ssr=false`). All user state lives in the browser — **SQLite-WASM in OPFS**, an append-only events log with aggregate tables the materializer derives from it. The only server anywhere is `worker/`, a Cloudflare Worker that **sequences and relays the events log and nothing else** — it never merges, never reads a payload, and the app is fully usable with it unreachable or switched off. Sync is opt-in per device and off unless the build sets `VITE_SYNC_URL`. The one other external call is a batched LLM request from the browser to OpenRouter with the user's own key.

**There is no `svelte.config.js`** — SvelteKit *and* vitest config live inline in `vite.config.ts`. **Runes mode is forced** project-wide: `$state`/`$derived`/`$effect`, `onclick` (not `on:click`).

One batched call writes a whole lesson including everything needed to grade locally, so play-time grading is free. **The model emits content, never presentation.** Mock mode routes deterministic fixtures through the *real* parse/resolve path, so the whole app is developable without spending tokens, and node tests are always in mock mode.

Every area is a registry with one module per member; forgetting a registration fails a specific gate rather than degrading silently.

| Area | The invariant that bites | Rule |
|---|---|---|
| `src/lib/llm/` | **Stateless** — never touches the DB. The top-up planner (`crates/sapling-challenges`) decides the wants; `getBatch` hands them to Rust (`crates/sapling-llm`) and returns challenges only: a lesson is written *about* the vocabulary it is given and introduces none. | `llm.md` |
| `src/lib/challenges/` | **Rust decides, TypeScript presents.** Grading, difficulty and every serve-time decision are `crates/sapling-challenges`', called **synchronously** through `core.ts` (the wasm is instantiated before the first render); what stays here is presentation, whose registry is a **mapped type over `ChallengeType`** — a new member of the generated union fails `pnpm check` at the registry. A served challenge is one stored row at one **help level**, and `presentationFor(challenge, shown)` turns the level into a screen. Grading is deliberately **type-blind**. | `challenges.md` |
| `src/lib/session/` | The orchestrator owns **all DB writes during play** and asks Rust for the decisions (`stream.rs`, `topup.rs`). **Practice is one stream until the learner stops**, and serving and refill read **one list through one predicate** (`stream.rs`): the next words in urgency order, each with its available row. Serving waits on the head while a batch can help it — a head with nothing waits for a background `top-up` — and passes it for the next word with something only when none can; refill writes for the words in the next low-water mark that have nothing. **Difficulty is one check on one learned scale**: `fits` (`fits.rs`) puts the chance *given the word is remembered* inside the window around the aim, widened per word to the nearest writable row (at the help levels a fresh row will actually be served at), and the writer solves the same check backwards — so every word always has something a refill can write that serving takes. Components emit answer events; they don't write. | `session.md` |
| `src/lib/tasks/` | Every long job is a task: **the runner owns status, cancellation and progress; pages never hold task state.** `TaskKind` is derived from the registry, so an unlisted kind fails `pnpm check` at the call site. In memory only. | `tasks.md` |
| `src/lib/assistant/` | The loop and the tools are Rust (`sapling-llm`'s `tools.rs`, `chat.rs`); every mutation goes through the `ToolContext` the host lends — `context.ts` over the repositories, the one DB import here — never the store directly. | `assistant.md` |
| `src/lib/conversation/` | Role-play on the assistant's seam, in Rust (`conversation.rs`): exposes exactly one tool — `add_words`, reused verbatim. Corrections travel beside the spoken line, never inside it — and `heard` puts the target script under a learner bubble that needed no correction. Only `diff.ts` (presentation) is TypeScript. | `assistant.md` |
| `src/lib/reading/` | Stateless too — **never imports `$lib/db`**; a text is immutable and **only the text** (segments, no readings, translations or glossary), every colour, reading and status is derived at render time, so the adaptive roll is memoised in a `Map` the *page* owns. Sentences exist only on screen, to place page breaks. | `reading.md` |
| `src/lib/media/` | The player is a **seam** — a `<video>`, YouTube's iframe, or (in Tauri) a hosted page framed over `postMessage`, behind one interface, and the reader never learns which. Only a *reference* is stored: a video id, or a file's name. `captions.ts` points the other way — how a subtitle track is *obtained* — and answers `undefined` where there is no host to ask, so a browser renders nothing about it. | `media.md` |
| `embed/` | One hosted page, **on its own origin and never in `static/`**: YouTube refuses a player to `tauri://localhost` (no referer, error 153), so the desktop app frames this. It imports the *real* `youtubePlayer` — one IFrame-API implementation, not two — and bridges `Player`, not the API. | `media.md`, `deploy.md` |
| `src/lib/db/` | Repositories are the **only** store access, and **the window thread never speaks SQL**: `protocol.ts`'s `Backend` is the boundary — generated, with `BACKEND_METHODS`, from the Rust method table into `generated/backend.ts` — and the Rust core implements it beside SQLite (in the Worker, or in-process in tests, via `host.ts`). The `events` table is the facts log; everything else is an aggregate read model the materializer maintains, and UI reads never touch `events`. `events.ts` is types only. | `data.md` |
| `crates/sapling-{domain,challenges,db,protocol,srs,import,llm,sync}/` | **The** persistence core, one job each. `domain`: event schemas and types, no SQL. `challenges`: the stored challenge union (the source of its TypeScript), grading, help levels, the **difficulty model** (one skill per word, one difficulty per row as shown, learned from answers — `model.rs`, replayed from the log by `replay.rs`, scored by the `calibrate` binary), serving and the session and top-up planners — a function of the pool, the words and the learned numbers, no SQL, no model call, run on the window thread through the wasm `challenges` export. `db`: DDL, merge rules and every `Backend` method over a four-line `Sql` trait — **it never opens a database** — including the difficulty model's numbers as derived data (`learned.rs`: skills, corrections, shared parts, folded from answers in `(at, id)` order whatever the arrival order). `protocol`: `Backend` by name over JSON — one `backend!` table expands into `dispatch` and the TypeScript `Backend` (and `llm!`/`challenges!`/`sync!` beside it for the window's calls), and every wire type derives `ts_rs::TS`, so **Rust is the only source of the protocol's TypeScript types**: `pnpm core:types` writes `src/lib/db/generated/` at build time, never committed. `srs`: the card state machine over the `fsrs` model, the card **and the numbers a screen reads off it**; no FSRS in the frontend. `import`: a pasted or uploaded text into the segments it is stored as — one per subtitle cue, one per paragraph, no model call — pure, behind `importSource`. `llm`: the model calls, the assistant's tools and loop included — prompts and mock fixtures as data files, the HTTP POST an injected transport, the word list an injected `ToolContext` — run on the window thread through the wasm `llm` export, never in the Worker. `sync`: the sync client — the push/pull cycle, probe, pairing and phrase over an injected HTTP transport and `SyncStore`, depending on `domain` alone, with a native `SyncStore` in `sapling-store`. `sapling-wasm` wraps them; `pnpm core:wasm` builds it into `src/lib/db/wasm/` (never committed) before every `pnpm` gate. | `core.md` |
| `crates/sapling-sync/`, `src/lib/sync/`, `worker/` | The backend **orders and relays; it never merges**. The client is Rust and **host-agnostic** — cycle, probe, pairing and phrase over an injected `Transport` and `SyncStore`, every failure an outcome value — run on the window thread through the wasm `sync` export; TypeScript keeps the phrase and switch in `localStorage`, `VITE_SYNC_URL`, the triggers and single flight. A learner is a pairing phrase; the *Worker* hashes it to pick the room, over its own normalise/validate that `fixtures/phrases.json` pins to the Rust. | `data.md`, `deploy.md`, `core.md` |
| `crates/sapling-desktop/`, `sapling-{store,speech,models,captions}` | A **spike**, and a host only — and `sapling-desktop` is just its Tauri glue; what it lends is four Tauri-free crates. `sapling-store`: the core over a SQLite file via its own rusqlite adapter (the only rusqlite) — no protocol, no merge rule, no SQL. `sapling-speech`: **speech both ways** on sherpa-onnx over `sapling-models`' pinned installs; the microphone stays in the webview. `sapling-captions`: `yt-dlp` off PATH (never pinned), raw `json3` back, never parsed. Only the desktop crate is not a default member (`nix develop .#desktop`). The Android APK is the same host **minus the player and the captions**, both target-scoped in the desktop manifest; `tts_status`'s `playback` tells the window which it got. | `desktop.md` |
| `src/lib/srs/` | **No FSRS here** — grades, opaque cards, timestamps. Every read attaches `srs: {due, retrievability, strength}` the core derived; `isDue` is `due <= now` and stays a frontend comparison. Retrievability is a word's memory in the difficulty model; **strength is display only**. | `data.md` |
| `src/lib/types.ts` | Every type is **generated from Rust** at build time and re-exported: change the struct. The `Challenge` union is `sapling-challenges`' — **additive optional fields only**, read leniently so every stored row keeps parsing. Hand-written only TS-only helpers. | `data.md` |
| `src/lib/romanize/` | Never romanize a term in isolation — context resolves polyphones. | `content.md` |
| `src/lib/tts/` | Audio failures degrade silently; sound never blocks gameplay. | `content.md` |
| `src/lib/asr/` | Dictation is an **input method, not a grader**: the transcript lands in the composer for the learner to send. Recognition isn't universal — the fallback is typing, never another engine. Two backends: the Tauri host's own recognizer for the languages *it* says it covers, else Web Speech. `dictationAvailable(lang)` is async and warms the probe `listen` then reads synchronously. | `content.md`, `desktop.md` |
| `src/app.css`, every `+page.svelte` | **Mobile-first with exactly two breakpoints** (48rem, 72rem, always `min-width`). Width buys a second column, a wider gutter or more density — **never a longer line of prose**. Every route but `/` and `/onboarding` renders `$lib/ui/BackLink` to its parent (never `history.back()`); the desktop shell has no back arrow, and `src/routes/back-link.test.ts` fails when a page forgets. | `layout.md` |
| `static/`, deploy | A missing `/_app/immutable/*` chunk must **404**, never fall through to the SPA shell. | `deploy.md` |

### Testing

Vitest, **node environment**, `src/**/*.test.ts`. No network, and no browser APIs — but the same SQLite-WASM package runs in-memory here, so the data layer is tested against a real store (`db/backend.testing.ts`, which `initSync`s the same wasm core the Worker fetches) rather than mocked: there is one implementation of the merge rules, not a write path and a replay path that have to be kept agreeing. The merge rules are also pinned by **golden fixtures** (`src/lib/db/fixtures/`, one event log in, every `Backend` read out as JSON) — language-neutral, so both `cargo test` (natively) and vitest (through the wasm build) run them, and any other implementation of the core would run the same files.
