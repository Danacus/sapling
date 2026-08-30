# CLAUDE.md

The app is called **Sapling** (manifest, titles, icon); the repo/package name stays `language-learning`/`language-app`.

## Commands

The repo ships a `flake.nix` devShell (Node 22 + pnpm + the language servers) with a `.envrc` (`use flake`), so direnv loads it automatically on `cd`. Fall back to `nix develop -c` only if direnv isn't active.

```sh
pnpm dev                                # dev server
pnpm build                              # static build -> build/
pnpm check                              # svelte-check + tsc -p worker (typecheck both targets)
pnpm test                               # vitest run (all suites)
pnpm test src/lib/srs/scheduler.test.ts # single test file
pnpm sync:dev                           # sync Worker locally (localhost:8787)
pnpm sync:deploy                        # deploy the sync Worker (wrangler)
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
| `src/lib/llm/` | **Stateless** — never touches the DB. `getBatch` returns challenges only: a lesson is written *about* the vocabulary it is given and introduces none. | `llm.md` |
| `src/lib/challenges/` | Registry is a **mapped type over `ChallengeType`** — a new member fails `pnpm check` at the registry. Grading is deliberately **type-blind**. | `challenges.md` |
| `src/lib/session/` | The orchestrator owns **all DB writes during play**. Components emit answer events; they don't write. | `session.md` |
| `src/lib/assistant/` | Every mutation goes through the injectable `ToolContext`, never the store directly — that's the seam the tests and the conversation layer both hang on. | `assistant.md` |
| `src/lib/conversation/` | Role-play on the assistant's seam: **never imports `$lib/db`**, and exposes exactly one tool — `add_words`, reused verbatim. Corrections travel beside the spoken line, never inside it — and `heard` puts the target script under a learner bubble that needed no correction. | `assistant.md` |
| `src/lib/reading/` | Stateless too — **never imports `$lib/db`**; a text is immutable and every colour, reading and status is derived at render time, so the adaptive roll is memoised in a `Map` the *page* owns. | `reading.md` |
| `src/lib/db/` | Repositories are the **only** store access. The `events` table is the facts log; everything else is an aggregate read model the materializer maintains, and UI reads never touch `events`. | `data.md` |
| `src/lib/sync/`, `worker/` | The backend **orders and relays; it never merges**. A learner is a pairing phrase; the *Worker* hashes it to pick the room. | `data.md`, `deploy.md` |
| `src/lib/srs/` | Pure and deterministic: every function takes `now` (epoch ms). | `data.md` |
| `src/lib/types.ts` | Treat as frozen; extend with **additive optional fields only**. | `data.md` |
| `src/lib/romanize/` | Never romanize a term in isolation — context resolves polyphones. | `content.md` |
| `src/lib/tts/` | Audio failures degrade silently; sound never blocks gameplay. | `content.md` |
| `src/lib/asr/` | Dictation is an **input method, not a grader**: the transcript lands in the composer for the learner to send. Recognition isn't universal — the fallback is typing. | `content.md` |
| `src/app.css`, every `+page.svelte` | **Mobile-first with exactly two breakpoints** (48rem, 72rem, always `min-width`). Width buys a second column, a wider gutter or more density — **never a longer line of prose**. | `layout.md` |
| `static/`, deploy | A missing `/_app/immutable/*` chunk must **404**, never fall through to the SPA shell. | `deploy.md` |

### Testing

Vitest, **node environment**, `src/**/*.test.ts`. No network, and no browser APIs — but the same SQLite-WASM package runs in-memory here, so the data layer is tested against a real store (`db/store.testing.ts`) rather than mocked: there is one implementation of the merge rules, not a write path and a replay path that have to be kept agreeing.
