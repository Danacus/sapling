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
- **2026-09-06, the sequel: with the plugins present, WebKitGTK's audio output
  is still not usable for speech.** Nothing crashes and nothing logs. `<audio>`
  over a blob plays the right sound about a second late, every time, because a
  fresh GStreamer pipeline is built per clip. Web Audio, which would build one
  pipeline and keep it, is worse: a bare oscillator alternates between clean and
  noise across runs and an `AudioBufferSourceNode` plays silence, while
  `decodeAudioData` on the same page is provably correct. Two commits went into
  that (e273058, reverted by f78eff6) before playback moved to the Rust host
  (`tts_play`/`tts_stop`, `crates/sapling-desktop/src/tts/play.rs`). **Do not
  re-attempt Web Audio here**, and do not "simplify" the desktop back to
  `<audio>` — it is the fallback on purpose. The GStreamer plugins above are
  still required, for the reader's `<video>` and the YouTube frame.
- **rodio's output stream is `!Send`** (it holds a `cpal::Stream`), so it takes
  the same one-owning-thread-and-a-channel shape `Core` does — and cpal's ALSA
  backend needs `alsa-lib` in the devShell at *build* time. That one fails
  loudly, unlike the three runtime-only traps above; at runtime on NixOS the
  ALSA default device reaches PipeWire through its plugin and needs nothing.
- **WebKitGTK has no OPFS** (`navigator.storage.getDirectory` is `undefined`)
  and no `SpeechRecognition`. The first is why the desktop build must run the
  native core — the sqlite-wasm/OPFS Worker cannot boot there at all. Both were
  measured, along with working cross-origin `fetch` to OpenRouter and a working
  YouTube iframe, from the real `tauri://localhost` origin; the standing
  findings are under "What the webview cannot do" in `docs/desktop.md`, and
  the measurements are in commit ffacf14.
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

## Android (the same crate, built only in CI)

- **`gen/android` is committed now (2026-09-07), and CI must not regenerate it.**
  It was generated per run until the app's icons and the edge-to-edge fix turned
  out to have no home but that tree — `tauri android init` writes Tauri's
  defaults back over both. The job checks the directory exists and fails if it
  does not. What `tauri android build` rewrites per run is covered by the
  generated project's own nested `.gitignore` files, so a build leaves the tree
  clean; the root `.gitignore` keeps only `gen/schemas/`.
- **`tauri icon` has no "Android only" flag**, and a pnpm *script* runs it from
  the repo root where there is no `tauri.conf.json`. So it is the one Tauri call
  here that wants `pnpm exec`, from `crates/sapling-desktop` — and it writes a
  desktop and iOS set into `crates/sapling-desktop/icons/` beside the mipmaps it
  was run for. Nothing reads that directory (`bundle.icon` names
  `static/icons/icon-512.png` and bundling is off); it is gitignored.
- **`android:windowOptOutEdgeToEdgeEnforcement` does not fix an overlapping
  status bar here, twice over.** Tauri's `MainActivity` template calls
  `enableEdgeToEdge()` explicitly, and the attribute only switches off the
  *framework's* enforcement — it cannot undo a window the app itself made
  edge-to-edge. And the generated project targets SDK 36, where the attribute is
  deprecated and ignored on an Android 16 device (it still works there for an
  app running on Android 15). The fix that holds on every version is insets as
  padding on the activity's content view, which is the `FrameLayout` wry calls
  `setContentView(webView)` on, so the WebView is sized to the safe area.
- **`tauri android init` writes the Gradle → CLI callback out of `argv[0]`, and
  gets it wrong unless a package manager is in the environment.** The generated
  `gen/android/buildSrc/.../BuildTask.kt` runs the Tauri CLI once per ABI
  (`android android-studio-script`), and `src/mobile/init.rs` picks that command
  by looking at how *you* invoked it: argv[0] with a `node` stem sends it
  looking for `PNPM_PACKAGE_NAME` or `npm_execpath`, and with neither set it
  falls back to `node tauri …` — which is not a thing, because there is no file
  called `tauri` in `crates/sapling-desktop`. `pnpm exec tauri android init`
  produces exactly that, and it fails much later, inside Gradle. Run the init
  through a **package.json script** (`pnpm desktop:android:init`) so
  `PNPM_PACKAGE_NAME` is set and the callback comes out `pnpm tauri android
  android-studio-script` — which is also why `"tauri": "tauri"` exists in
  `package.json` and must stay: Gradle calls it by that name, from
  `crates/sapling-desktop`, and pnpm walks up to the root manifest to find it.
- **`tauri android init` needs the SDK, the NDK *and* rustup just to write
  files — but it never uses them.** It checks `ANDROID_HOME`, reads
  `$NDK_HOME/source.properties` for a version, and shells out to `rustup target
  add` before it generates anything. There is no "generate the project offline"
  mode, and there does not need to be: two empty directories, a one-line
  `source.properties` and a `rustup` shim that exits 0 satisfy every check, and
  the tree that comes out is the real one. That is how `gen/android` was written
  on a machine with no Android tooling (`docs/desktop.md` has the snippet).
  Check the result for absolute paths — `BuildTask.kt` is where a path from the
  generating machine would land — but with the init run as a pnpm script the
  callback is just `pnpm`.
- **A build script's `#[cfg(target_os = …)]` is the *host's*.** `build.rs` runs
  on the machine doing the building, so the attribute answers for the laptop and
  not for the phone. `CARGO_CFG_TARGET_OS` is the question actually being asked;
  in this crate it decides whether to emit the sherpa `$ORIGIN` rpath link arg.
- **A feature may name an optional dependency that only exists for some
  targets.** `tts = ["dep:rodio", …]` with those dependencies declared under
  `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`
  resolves to nothing on Android and to the voice everywhere else — one feature,
  no second configuration to keep in step. `cargo tree -p sapling-desktop
  --target aarch64-linux-android` is how to check what a target actually gets.
- **Gradle builds the whole package, `[[bin]]` included** — cargo-mobile2 runs
  `cargo build -p <crate> --target <triple>` with no `--lib`. On Android the app
  is the cdylib (`TauriActivity` loads `libsapling_desktop.so` and calls
  `start_app`), so `main.rs` is deliberately empty there rather than an
  executable nothing can launch.

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
- **A reload guard that clears itself at load time is not a guard (2026-09-07).**
  `+layout.svelte` reloads once on `vite:preloadError` to heal a tab left open
  across a deploy. It also cleared its sessionStorage flag as the script ran,
  which is *before* the failing import is attempted — so a chunk that fails on
  every load reloaded forever, which is what an Android build did on the settings
  page. `afterNavigate` alone does not fix it either, and that is the subtle
  half: the import that failed there is fired by an effect *after* the page has
  mounted, so the landing navigation completes first and clears the flag a
  heartbeat before the failure. The flag is cleared by `afterNavigate` **minus
  `type === 'enter'`** — the learner going somewhere else is evidence the app
  works; landing where the reload put us is not. Log the failing URL before
  reloading, too: the reload cancels
  the error, so on a host with no devtools it is the only report there will be.
  And do not call `preventDefault()` on that event — Vite rethrows an
  unprevented one, which is what lets the awaiting caller see its rejection
  instead of a module that resolved to `undefined`.
- **A `.then` chained onto a dynamic `import()` is inside Vite's preload helper
  (2026-09-07).** Rolldown-Vite rewrites `import('./x').then(m => m.f())` to
  `__vitePreload(() => import('./x').then(m => m.f()), deps)`, so a rejection
  from `f()` is reported as `vite:preloadError` — a chunk that failed to load —
  and the layout's heal-by-reload fires for it. That was one reload per first
  visit to Settings on Android, where `tts_status` is not a command: the log
  named the payload `Command tts_status not found`, not a URL. `await` the
  import on its own statement and call the export on the next; the helper then
  wraps the import alone. Grep a built chunk for `vite:preloadError` payloads
  that are not fetch errors when the guard fires on a host with every file.
- **SvelteKit registers `/service-worker.js` on the Android Tauri host too, and
  it fails there.** The page is served from `http://tauri.localhost` and the
  fetch errors ("unknown error occurred when fetching the script"), leaving one
  unhandled rejection per load in logcat. Harmless — the shell ships its own
  assets — and not worth a host-shaped exception in `kit.serviceWorker`.
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
