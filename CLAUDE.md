# CLAUDE.md

The app is called **Sapling** (manifest, titles, icon); the repo/package name stays `language-learning`/`language-app`.

## Commands

The repo ships a `flake.nix` devShell (Node 22 + pnpm + the language servers) with a `.envrc` (`use flake`), so direnv loads it automatically on `cd`. Fall back to `nix develop -c` only if direnv isn't active.

```sh
pnpm dev                                # dev server
pnpm build                              # static build -> build/
pnpm check                              # svelte-check (typecheck)
pnpm test                               # vitest run (all suites)
pnpm test src/lib/srs/scheduler.test.ts # single test file
pnpm format                             # prettier --write . (bulk pass)
pnpm format:check                       # prettier --check . (verify only)
```

The sync server in `server/` is a **separate package, deliberately not a workspace member** — its own `package.json`, lockfile and `node_modules`, so the Cloudflare Pages build never sees it. `cd server && pnpm install` once, then `pnpm test` / `pnpm typecheck` / `pnpm dev` (tsx watch on :8787).

**Formatting is automatic — never hand-align code.** A `PostToolUse` hook runs the repo-pinned prettier on every file Claude edits; a `PreToolUse` hook blocks unpinned `prettier` and `npm`/`yarn install`. Style lives in `.prettierrc`. `.prettierignore` keeps markdown and the vendored `static/tts/sherpa-onnx-*.js` out.

Nix flakes only see files that are `git add`ed — a brand-new file the flake needs must be staged first. `pnpm-workspace.yaml` records pnpm's `allowBuilds` decisions; an undecided one hard-fails Cloudflare Pages' CI install.

## Working in this repo

`.claude/` carries the repetitive parts so they don't have to be re-explained:

- **`locate` agent** (Haiku, read-only) — "where does X live, what touches it". Delegate sweeps to it rather than grepping in the main context.
- **`verify` agent** (Haiku, read-only) — runs `pnpm check`, `pnpm test`, `pnpm format:check` plus the `server/` gates when `server/` changed, and reports a table.
- **Skills** — `add-challenge-type`, `add-assistant-tool` (procedures + the gate that catches each omission), `prompt-tuning` (content-quality bugs), `sync-contract` and `gotchas` (auto-loaded reference).
- **`.claude/rules/*.md`** — the per-area module contracts. Each is `paths:`-scoped and loads only when a matching file is read, so the detail arrives when it applies. **The table below is the summary; the rule is the contract.**
- **Hooks** — format-on-save, the package-manager guard, and Bash-side equivalents of both.

**Prefer `Edit`/`Write` over `sed`/heredocs for file changes.** Path-scoped rules load on the `Read` tool and the formatter runs on `Edit`/`Write`, so shell-driven edits bypass both. The Bash hooks cover that case, but they match paths out of the command text and are the fallback, not the design.

When writing a new agent: an explicit `tools:` allowlist **silently drops the `Skill` tool**, so an agent that should use a skill needs `Skill` listed, or the skill preloaded via `skills:`.

## Architecture

Local-first static SPA (SvelteKit 2 + Svelte 5, `adapter-static`, `ssr=false`), no backend. All user state lives in the browser. The one external call is a batched LLM request from the browser to OpenRouter with the user's own key.

**There is no `svelte.config.js`** — SvelteKit *and* vitest config live inline in `vite.config.ts`. **Runes mode is forced** project-wide: `$state`/`$derived`/`$effect`, `onclick` (not `on:click`).

One batched call writes a whole lesson including everything needed to grade locally, so play-time grading is free. **The model emits content, never presentation.** Mock mode routes deterministic fixtures through the *real* parse/resolve path, so the whole app is developable without spending tokens, and node tests are always in mock mode.

Every area is a registry with one module per member; forgetting a registration fails a specific gate rather than degrading silently.

| Area | The invariant that bites | Rule |
|---|---|---|
| `src/lib/llm/` | **Stateless** — never touches the DB. `getBatch` returns `fsrsCard: null`; the caller initializes card state. | `llm.md` |
| `src/lib/challenges/` | Registry is a **mapped type over `ChallengeType`** — a new member fails `pnpm check` at the registry. Grading is deliberately **type-blind**. | `challenges.md` |
| `src/lib/session/` | The orchestrator owns **all DB writes during play**. Components emit answer events; they don't write. | `session.md` |
| `src/lib/assistant/` | Every mutation goes through the injectable `ToolContext`, never Dexie directly — that's what captures sync events. | `assistant.md` |
| `src/lib/conversation/` | Role-play on the assistant's seam: **never imports `$lib/db`**, and exposes exactly one tool — `add_words`, reused verbatim. Corrections travel beside the spoken line, never inside it. | `assistant.md` |
| `src/lib/db/` | Repositories are the **only** Dexie access. Every write passes `toPlain()`; a `$state` proxy throws `DataCloneError`. | `data.md` |
| `src/lib/srs/` | Pure and deterministic: every function takes `now` (epoch ms). | `data.md` |
| `src/lib/types.ts` | Treat as frozen; extend with **additive optional fields only**. | `data.md` |
| `src/lib/sync/` + `server/` | `events.ts` is **zod-only and import-free** — the server compiles it by relative path. The server merges nothing. | `sync.md` |
| `src/lib/romanize/` | Never romanize a term in isolation — context resolves polyphones. | `content.md` |
| `src/lib/tts/` | Audio failures degrade silently; sound never blocks gameplay. | `content.md` |
| `static/`, deploy | A missing `/_app/immutable/*` chunk must **404**, never fall through to the SPA shell. | `deploy.md` |

### Testing

Vitest, **node environment**, `src/**/*.test.ts` — pure logic only. No IndexedDB (Dexie code is covered by typecheck/build), no WASM, no network. DB-dependent engine logic is tested by mocking `$lib/db` per-file.
