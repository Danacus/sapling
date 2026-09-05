---
name: gotchas
description: >
  Sapling's log of pitfalls that already cost real debugging time. Load before
  touching TTS/sherpa/Kokoro, Cloudflare headers or redirects, the service
  worker, SQLite/OPFS persistence, the nix flake or pnpm-workspace.yaml — and
  whenever a command or a "fix" fails in a way that doesn't make sense.
user-invocable: false
---

# Gotchas

Each entry is here because it already went wrong once. Append rather than
rewrite; a dated line about a real incident is worth more than a tidy rule.

## Persistence

- **Never hand a Svelte `$state` proxy across `postMessage`.** IndexedDB and
  Dexie are gone, but the reason for `toPlain()` survived them: every backend
  call crosses `postMessage` to the SQLite Worker, which uses structured clone
  and throws `DataCloneError` on a bare Proxy just the same. `db/client.ts`
  runs every argument through `toPlain()` at the transport, so no caller has
  to — and nothing on the window thread may bypass the client to reach the
  Worker. Repositories are the only store access.
- API key and prefs live in **localStorage** (`ll.*` keys, via `db/settings.ts`
  and `ui/prefs.ts`) — never in the store, and never in the JSON export.
- **The SQLite SAH-pool VFS is exclusive.** Only one tab can hold `/sapling.db`
  at a time; a second tab's boot fails with "Sapling is already open in another
  tab." — close the other tab and reload. There is no leader election.
- **The core is a build artefact.** `src/lib/db/wasm/` is gitignored and
  written by `pnpm core:wasm`; `Cannot find module './wasm/sapling_core'` from
  vitest or svelte-check means it has not run. Every `pnpm dev|build|check|test`
  script chains it first (explicitly, not via `pre*` hooks), so use those rather
  than calling `vite`/`vitest` directly after touching `crates/`. A stale
  artefact runs stale merge rules silently — the golden tests are what notice.
- **`undefined` does not cross the wasm boundary; `null` does.** `host.ts`
  sends arguments as a JSON array, so a trailing `undefined` becomes `null` and
  `dispatch.rs` reads `null` as "absent" — which is why no `Backend` argument
  may mean something by being `null`. Answers go the other way: a method that
  returns nothing, or a read of a missing row, returns no string at all and the
  host hands back `undefined`, matching the TypeScript signatures.

## TTS

- The int8 Kokoro variant is a **known upstream NaN/silence bug in the WASM
  build**. It is smaller and it is tempting. Don't "optimize" back to it; the
  fp32 artifacts (~439MB) are the working ones.
- **2026-09-05, the other half of that:** the int8 bug does *not* reproduce
  natively. `kokoro-int8-multi-lang-v1_1` under native sherpa-onnx synthesized
  six clips across Mandarin and English with zero NaN samples and normal peaks,
  where the WASM build returns all-`NaN`. So sherpa-onnx#2236 is a fact about
  that Emscripten build, not about the quantized weights — and it is still not a
  reason to ship int8 on the desktop, because one model on both hosts is worth
  more than 218 MB.
- `static/tts/sherpa-worker.js` is **plain JS outside Vite on purpose** — a
  bundled TS worker diverged between dev and build. Config reaches it via the
  init message from `sherpa.ts`; `models.ts` is the single source of truth for
  artifact URLs and sizes.
- Audio failures must degrade silently to fallback. Sound never blocks gameplay.

## Desktop (Tauri)

- **2026-09-05: in WebKitGTK without the GStreamer plugins, `new AudioContext()`
  kills the whole web process.** Not a silent failure, not a caught exception —
  the page vanishes and stderr shows `GStreamer element appsink not found`
  followed by `GStreamer-CRITICAL` assertions. WebKitGTK routes *Web Audio*
  through GStreamer, not just `<video>`, so this is every spoken word.
  `flake.nix`'s `desktop` shell carries `gst-plugins-{base,good,bad}` +
  `gst-libav` and exports `GST_PLUGIN_SYSTEM_PATH_1_0` for this reason.
  `glib-networking` (`GIO_MODULE_DIR`) is the same shape of trap one step
  earlier: runtime-only, no build error, every `https://` request fails.
- **WebKitGTK has no OPFS** (`navigator.storage.getDirectory` is `undefined`)
  and no `SpeechRecognition`. The first is why the desktop build must run the
  native core — the sqlite-wasm/OPFS Worker cannot boot there at all. Both were
  measured, along with working cross-origin `fetch` to OpenRouter and a working
  YouTube iframe, from the real `tauri://localhost` origin; the table is in
  `docs/desktop.md`.
- **`Core` is `!Send`, so `Mutex<Core>` is not a way to share it.** Its `Sql`,
  clock, ids and calendar are plain boxed trait objects and have to stay that
  way, because the wasm host's `JsSql` holds a `js_sys::Function`. Adding
  `+ Send` to the core's bounds would break the browser build. `host.rs` gives
  the core its own thread and posts closures to it instead.
- **In a nix `let`, a binding shadows a `with`.** `gstreamer = with
  pkgs.gst_all_1; [ gstreamer ... ]` refers to *itself* and fails with
  `error: stack overflow; max-call-depth exceeded`, which reads like a nixpkgs
  bug and is not one. The binding is named `gst`.
- `cargo tauri` finds a project by the `tauri.conf.json` beside a `Cargo.toml`,
  searching the cwd and `src-tauri/`. There is no `src-tauri/` here, so the
  scripts `cd crates/sapling-desktop` first, and `beforeDevCommand` carries an
  explicit `cwd: "../.."` to run `pnpm dev` back at the repo root.
- **`bundle.icon` paths resolve relative to `tauri.conf.json`, and a missing one
  fails inside `generate_context!()`** — a proc-macro panic pointing at
  `.run(...)`, not at the config.
- **2026-09-05: `sherpa-rs` 0.6.8 frees the rule-FST path before sherpa-onnx
  reads it.** `KokoroTts::new` does
  `raw.rule_fsts.map(|v| v.as_ptr()).unwrap_or(null())`, and `Option::map`
  *consumes* the `CString` — so the pointer dangles the moment the closure
  returns. The symptom is `Rule fst '<mojibake>' does not exist`, then `Errors
  in config`, then a null engine and a SIGSEGV on the next call. Present on the
  crate's `main` too. Every other field in that constructor is fine, so it only
  bites when `rule_fsts`/`rule_fars` are non-empty — which for Chinese they must
  be, or digits fall through to espeak and "3" is read as English "three" inside
  a Chinese sentence. The fix here was to depend on `sherpa-rs-sys` and write
  the twenty lines ourselves (`crates/sapling-desktop/src/tts/kokoro.rs`).
- **Do not link sherpa-rs-sys's bindings against nixpkgs' `sherpa-onnx`.** The
  crate vendors headers for one exact tag (v1.12.9) and its `download-binaries`
  feature fetches k2-fsa's prebuilt libraries for that same tag; nixpkgs ships
  1.12.38, whose `SherpaOnnxOfflineTtsModelConfig` gained three members, so
  every field after it moves and the two sides silently disagree about the
  config being passed. `SHERPA_LIB_PATH` makes this trivially easy to do and
  nothing warns.
- **Kokoro v1.1 needs `dict_dir` on sherpa-onnx v1.12.9.** The browser worker
  leaves it empty with a comment saying a dict dir "only logs a not-used
  warning" — true from v1.12.15. Before that the multi-lingual frontend refuses
  to start: `please pass --kokoro-lexicon and --kokoro-dict-dir`, then
  `exit(255)`. The archive's own `dict/` is what it wants.
- **A prebuilt `.so` dropped next to a Rust binary is not found at runtime.**
  `sherpa-rs-sys` copies sherpa-onnx and onnxruntime into `target/<profile>/`
  and `target/<profile>/deps/` but adds no rpath, so the binary dies with
  `libsherpa-onnx-c-api.so: cannot open shared object file`.
  `cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN` in `build.rs` fixes it for binaries
  *and* tests. Their own dependency on libstdc++ is a separate problem:
  `DT_RUNPATH` on the executable is not consulted for a shared library's
  dependencies, so the devShell has to put `stdenv.cc.cc.lib` on
  `LD_LIBRARY_PATH`. Same runtime-only shape as `glib-networking` and GStreamer.
- **Native Kokoro is not bit-reproducible.** ONNX reduces in whatever order its
  threads finish, so the same phrase twice differs in the low bits of some
  samples and by a few samples of length (measured: 181454 vs 181442 bytes).
  Fine in practice — clips key on text, speaker and speed — but a test that
  asserts equal bytes will flake.

## Deploying / edge caching

- **2026-08-24 incident:** `/_app/immutable/*` must serve a real 404
  (`static/404.html`) on a miss, *not* fall through to the SPA shell. A single
  stale-client request for a dead hashed chunk gets edge-cached under the
  immutable header and poisons that URL for everyone for up to a year.
  `static/_redirects` encodes this — don't simplify it to a blanket fallback.
- **2026-08-29, a correction:** this file used to say cross-origin isolation
  breaks the TTS model-mirror fetches. It does not. Measured under
  `COOP: same-origin` + `COEP: require-corp`, the app boots with
  `crossOriginIsolated = true` and both sherpa artifacts still load 200. COEP
  imposes CORP on **no-cors** subresources only, and `sherpa-worker.js` uses a
  bare `fetch(url)` (mode `cors`) against a mirror sending
  `access-control-allow-origin: *`. `static/_headers` still sets no COOP/COEP —
  because nothing needs isolation, not because it is unavailable. Firefox only;
  re-check in Chrome before enabling. The wrong version of this note nearly cost
  a needless plan to self-host 439MB of Kokoro voices.
- **SvelteKit's `$service-worker` `build` list omits Vite worker output.** It is
  assembled purely from Vite's *client manifest*, and a `?worker` import is a
  separate Rollup build that never appears there. Anything loaded via `?worker`
  is served but never precached, so it works everywhere except offline, and only
  for users who already installed the PWA — `install` still succeeds, so nothing
  looks wrong. `kit.serviceWorker.files` cannot reach it either; it filters
  `static/` only.
- **A `?worker` graph emits its own copy of every shared asset.** SvelteKit gives
  it a separate asset directory *and* naming pattern (`workers/assets/[name]-[hash]`
  vs `assets/[name].[hash]`), so an asset both graphs need is downloaded and
  compiled twice. This only bites when the *same* asset is needed on both sides
  of a `?worker` boundary — the sqlite-wasm binary today is loaded only inside
  `sqlite.worker.ts`, not on the window thread, so there is nothing to dedupe
  and `vite.config.ts` carries no plugin for it. If a future asset needs both
  sides again, realign the patterns from a plugin ordered **after** `sveltekit()`
  — setting `worker.rollupOptions` at the top level is silently overridden by
  SvelteKit's own `config` hook.
- `pnpm-workspace.yaml` records pnpm's dependency build-script decisions
  (`allowBuilds`). An **undecided** script hard-fails Cloudflare Pages' CI
  install. Keep decisions explicit there.

## Toolchain

- **Nix flakes only see files that are `git add`ed.** A brand-new file the flake
  needs must be staged before direnv (or `nix develop`) picks it up. This looks
  exactly like "the flake is broken".
- **`wasm-bindgen-cli` and the `wasm-bindgen` crate must be the same version,
  to the patch.** The CLI reads a schema the macro embedded in the `.wasm` and
  refuses any other version with a long, unhelpful error. The crate is pinned
  `=` in `crates/sapling-wasm/Cargo.toml` to what the flake's nixpkgs ships
  (`wasm-bindgen --version`); bumping the flake lock means re-pinning the crate,
  and `nix eval` against a *different* nixpkgs than the lock will tell you the
  wrong version.
- **The wasm target links with `lld`, and nixpkgs' rustc does not bundle it.**
  `error: linker 'lld' not found` from `cargo build --target
  wasm32-unknown-unknown` means the devShell is missing `pkgs.lld`, not that
  the target's std is missing — rustc's sysroot already ships
  `wasm32-unknown-unknown`, so no overlay or rustup is needed.
- `server/` is a separate package with its own `node_modules`. Its tests fail
  confusingly until `cd server && pnpm install` has run once.

## Content

- **Never romanize a term in isolation.** `romanize/zh.ts` puts the *whole*
  string through pinyin-pro and slices readings per character, because context
  is what resolves polyphones (银行 háng vs 自行车 xíng).
- Old challenges keep playing as they were generated. Prompt and schema changes
  reach the pool **only via newly generated batches** — the most common cause of
  a "the fix didn't work" report.

## Adding to this file

When a command, test or fix fails in a way that surprised you, add the entry
here in one or two lines: what looked wrong, and what was actually true.
