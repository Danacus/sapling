# Desktop (Tauri v2) — a spike

Contracts: `.claude/rules/desktop.md`, `.claude/rules/core.md`.
Code: `crates/sapling-desktop/`, `src/lib/db/tauri.ts`, `src/lib/tts/native.ts`,
`src/lib/platform.ts`.

**This is a spike, not a product.** It exists to answer one question — can the
Rust persistence core run natively over a SQLite file behind the *existing*
domain protocol, with the same SvelteKit app on top? It can, and the app boots
to onboarding through it. Since then it has grown a second native capability,
the voice (see [Speech](#speech)), for the same reason: the webview cannot run
the browser's implementation at all. Nothing in the web build, the gates or CI
depends on any of it: the desktop crate is a workspace member but not a
*default* member, and its toolchain lives in a second devShell.

## Running it

Everything runs inside the desktop shell, which the default one does not
provide:

```sh
nix develop .#desktop -c pnpm desktop:dev     # vite dev + the window, hot reload
nix develop .#desktop -c pnpm desktop:build   # pnpm build + a release binary
nix develop .#desktop -c pnpm desktop:check   # clippy -D warnings + the crate's test
```

`pnpm desktop:dev` `cd`s into `crates/sapling-desktop` (the Tauri CLI finds a
project by the `tauri.conf.json` beside its `Cargo.toml`, and there is no
`src-tauri/` here) and Tauri's `beforeDevCommand` runs `pnpm dev` back at the
repo root via the config's `cwd: "../.."`. `desktop:build` produces
`target/release/sapling-desktop`; `bundle.active` is `false`, so there is no
`.deb`/`.AppImage` and `--no-bundle` is passed — packaging is out of scope for a
spike and would need a full icon set.

New files must be `git add`ed before nix sees them (flakes read the index, not
the working tree). This looks exactly like "the flake is broken".

## Where the data lives

Tauri's per-app data directory, named by the config's `identifier`
(`app.sapling.desktop`):

| platform | path |
|---|---|
| Linux | `~/.local/share/app.sapling.desktop/` |
| macOS | `~/Library/Application Support/app.sapling.desktop/` |
| Windows | `%APPDATA%\app.sapling.desktop\` |

Inside it: `sapling.db` (plus `-wal`/`-shm` — the file is opened in WAL mode)
and `device-id`, one UUID v4 minted on first run. The device id is a *file* and
not a row because it is half of a review's identity and has to survive
`resetData`, which empties the database including `meta`. WebKit puts its own
caches and local storage in the same directory, which is also where the API key
and prefs end up — they are `localStorage` on both hosts, never in the store.

Also inside it, once the voice has been downloaded: `tts/kokoro-multi-lang-v1_1/`,
about 407 MB of ordinary files (see [Speech](#speech)).

Deleting the directory is a factory reset.

## What is native and what still goes through the webview

**Native: persistence and synthesis.** `crates/sapling-desktop` opens the file,
lends `sapling-core` the four runtime facts (`deviceId`, the system clock,
`localDay` from the system time zone, UUID v4 ids) and exposes exactly the three
commands `WasmCore` exposes to the database Worker — `dispatch`, `commit_all`,
`derived_schema_version`. `src/lib/db/tauri.ts` is one `invoke` per `Backend`
call, chosen by `backend.ts` when `inTauri()`; every argument still goes through
`toPlain()`, because `client.ts` owns the proxy for both transports. The voice
adds three more commands and is the section below.

Both are host capabilities in the same narrow sense — a file, and text-in
audio-out. Neither carries a merge rule, a lesson, or a language.

**Everything else is the same web app in a webview**: the UI, the LLM call to
OpenRouter, audio *playback*, ASR, the reading and conversation layers, the
romanizer. There is no native menu, no tray, no auto-update, no file dialog and
no deep-link handling. The window is one `main` window loading `/`.

**No CSP.** `app.security.csp` is `null`, matching the web deploy, which sets
none either and for a load-bearing reason (`deploy.md`: the YouTube iframe API
and the `youtube-nocookie` frame). Tauri's default is to inject one; turning it
off is a deliberate spike shortcut, and a shipped build should set a policy that
names those two origins rather than inherit this.

**SPA routing.** In a packaged build the app is served from `tauri://localhost`
over the custom protocol, which does *not* fall back to `index.html` the way
`static/_redirects` does. Starting at `/` works and client-side navigation
works; a reload on a deep route would not. Untested, because nothing reloads.

## Speech

**Why any of this is native.** The browser runs Kokoro as sherpa-onnx compiled
to WASM in a Worker, and that path cannot exist here: the engine is a 439 MB
Emscripten *file package* whose byte offsets are baked into vendored glue, and
this webview has no `SharedArrayBuffer`. So synthesis moved to Rust — and only
synthesis. Playback stays in the webview, because `<audio>` over a blob works
there (given the GStreamer plugins the shell carries) and one player for both
hosts is worth more than a native audio stack.

Nothing above the seam moved with it. `speak(text, lang)` is unchanged, the
`ll.ttsEngine` preference still reads `'kokoro' | 'webspeech' | 'off'`, and
`'kokoro'` still means the good downloaded neural voice — now from whichever
host provides it. The speaker ids in `languages.ts` are the same numbers
because it is the same model.

**The model.** `kokoro-multi-lang-v1_1`, fp32, taken from k2-fsa's own release
assets rather than the third-party mirror the browser needs — native
sherpa-onnx reads ordinary files, so there is no repackaged bundle in the trust
path:

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2
364,816,464 B   sha256 a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad
```

URL, size and hash are one constant, `KOKORO` in `src/tts/model.rs`. The
archive is streamed to `<app-data>/tts/*.part`, hashed as it lands, verified
against both numbers, and only then unpacked — into `<app-data>/tts/`, where
its own top-level directory becomes `kokoro-multi-lang-v1_1/` (about 407 MB).
Any failure removes the part file and the directory, so "installed" is never
half true. Download and unpack each report progress, so the bar covers the
whole minute rather than sitting at 100% through bzip2.

**The commands**, and there are only three:

| command | answers |
|---|---|
| `tts_status()` | model name, installed, bytes on disk, bytes a fresh download costs, whether the engine is warm |
| `tts_download()` | nothing; idempotent, verifies, emits `tts://model-progress` |
| `tts_synthesize(text, sid, speed)` | a complete WAV file as a binary IPC payload |

`tts_synthesize` returns `tauri::ipc::Response`, not a `Vec<u8>`: the latter
crosses as a JSON array of numbers, which for one sentence is megabytes of text
parsed on the window thread for audio already in the right format. Both long
commands are `async` and run their work on `spawn_blocking` — a synchronous
Tauri command runs on the main thread, and a second of inference there is a
frozen window. The engine is built on the first phrase and kept for the life of
the process, behind a `Mutex` because sherpa-onnx promises nothing about
concurrent generation.

**Two deliberate differences from the browser**, both visible in Settings:

- **No warm-up command.** `preloadKokoro` downloads the model and stops there;
  the engine's ~2 s load happens on the first synthesis. That is not a hole:
  the session screen calls `warmSpeech` the moment a challenge is shown, so the
  load lands while the learner is reading the question rather than after they
  answer.
- **No stored clip cache.** Cache Storage (`ll-tts-audio`) is skipped here. It
  exists to avoid the browser's one-to-two seconds of WASM inference per
  phrase; natively synthesis runs at several times real time, so a clip is
  cheaper to re-make than to keep, and the memory LRU still absorbs replays.
  The Settings "Audio cache" row is hidden unless something actually did write
  clips.

**Measured** on this machine (16 threads, the model on an SSD), from
`tests/voice.rs`:

| | |
|---|---|
| download + verify + unpack | 60 s |
| engine load (once per launch) | ~2.1 s |
| Mandarin, 3.78 s of audio | 0.96–1.02 s (≈3.8× real time) |
| English, 1.76 s of audio | 0.47–0.51 s (≈3.5× real time) |
| mixed zh/en, 2.48 s of audio | ~3.0 s (first call, includes the load) |

Synthesis is **not** bit-reproducible: ONNX reduces in whatever order its
threads finish, so the same phrase twice differs in the low bits and by a few
samples of length. Harmless — clips key on text, speaker and speed, so a
learner hears one rendering — but do not write a test that expects equal bytes.

**The int8 question, answered.** `models.ts` records that every published int8
Kokoro WASM build returns all-`NaN` samples (sherpa-onnx#2236), which is why
the browser pays for fp32. Natively it does not reproduce:
`kokoro-int8-multi-lang-v1_1` (147 MB) synthesized six clips across both
languages with zero NaN samples and normal peaks. So that bug belongs to the
WASM build, not to the quantized weights. fp32 still ships on both hosts — one
model, one sound, and no reason to introduce a second answer to "what does this
word sound like" for 218 MB.

**How sherpa-onnx is linked.** `sherpa-rs-sys` with `download-binaries`: it
vendors sherpa-onnx's headers for one exact tag (v1.12.9) and its build script
downloads k2-fsa's prebuilt shared libraries for that same tag into
`~/.cache/sherpa-rs`. Two things fall out of that and both cost time to find:

- **Do not point it at nixpkgs' `sherpa-onnx` instead.** That package is 1.12.38,
  whose `SherpaOnnxOfflineTtsModelConfig` has three members the 1.12.9 headers
  do not, so every field after it sits at a different offset — the bindings and
  the library would silently disagree about the config being passed.
- **v1.12.9 is before the change that made `dict_dir` optional**, so the
  multi-lang Kokoro frontend refuses to start without the archive's jieba
  dictionaries. The browser worker leaves `dictDir` empty (correctly, for
  v1.12.15+); this host passes `dict/`.

`build.rs` adds `-Wl,-rpath,$ORIGIN` so the binaries find the two `.so` files
the build script drops beside them, and the devShell puts libstdc++ on
`LD_LIBRARY_PATH` because a shared library's own dependencies are not resolved
through the executable's `DT_RUNPATH`.

`tts::kokoro` is the crate's only `unsafe` — the root denies rather than
forbids it — because `sherpa-rs`, the safe wrapper, frees the rule-FST path
string before sherpa-onnx reads it (`Option::map` consumes the `CString`).
Dropping the FSTs instead would mean "2026" read as English digits inside a
Chinese sentence on this host only, so the twenty lines the wrapper would have
contributed live here instead, with the strings kept alive across the call.

## What actually happens in WebKitGTK

Measured 2026-09-05 on NixOS, GNOME/Wayland, webkitgtk 2.52.6 (abi 4.1), Tauri
2.11.5, from a page loaded on the real `tauri://localhost` origin.

| feature | observed |
|---|---|
| `navigator.storage.getDirectory` (OPFS) | **`undefined`** |
| `SpeechRecognition` / `webkitSpeechRecognition` | **`undefined`** |
| `SharedArrayBuffer`, `crossOriginIsolated` | `undefined`, `false` |
| `WebAssembly` + `instantiateStreaming` | present |
| `Worker`, `AudioContext`, `AudioWorklet` | present |
| `speechSynthesis` | present (object) |
| `navigator.mediaDevices.getUserMedia` | present |
| `localStorage`, `crypto.randomUUID`, `serviceWorker` | present |
| `fetch https://openrouter.ai/api/v1/models` | `200`, response type `cors` |
| `fetch` POST to OpenRouter with no key | `401`, response type `cors` |
| `fetch https://huggingface.co/...` (TTS mirror host) | `200`, response type `cors` |
| `https://www.youtube.com/iframe_api` as a `<script>` | loads, `window.YT` is an object |
| `<iframe src="https://www.youtube-nocookie.com/embed/…">` | `onload` fires |

Item by item, against the things the brief asked about:

- **OPFS is absent, and that is the finding that justifies the whole exercise.**
  The browser persistence path — sqlite-wasm on the OPFS SAH-pool VFS inside
  `sqlite.worker.ts` — cannot run in this webview at all. The native core is not
  a performance choice here; it is the only way the app has a database. The
  Worker is never even loaded: on a real boot the webview fetched
  `src/lib/db/tauri.ts` and never `sqlite.worker.ts`.

- **Speech recognition is gone.** WebKitGTK exposes neither constructor, so
  dictation has no input method. `content.md` already says ASR is an input
  method and not a grader and that the fallback is typing, so the app degrades
  the way it was designed to — but on this host the fallback is the only path.
  `getUserMedia` *is* present, so a future recorder-plus-server transcription
  route is not blocked by the webview.

- **Cross-origin `fetch` from `tauri://localhost` works.** OpenRouter answered
  `200`/`401` with `type: "cors"`, so the API key path is fine as-is with no
  Rust-side HTTP proxy and no `tauri-plugin-http`. Same for the TTS model
  mirror's host. This was the risk that looked biggest going in and it is a
  non-issue.

- **The YouTube player loads.** Both halves of `media.md`'s YouTube path — the
  `iframe_api` script and the `youtube-nocookie` frame — load from the custom
  protocol origin. Playback itself was not driven (no interaction possible in
  this session), so "the API is reachable" is what was proven, not "a video
  plays".

- **The sherpa TTS wasm was never exercised, and now never will be.** Every
  prerequisite was there — `WebAssembly` with streaming instantiation,
  `Worker`, `AudioContext`, `AudioWorklet`, a working cross-origin `fetch` to
  the mirror — except `SharedArrayBuffer`, and the vendored glue is
  single-threaded, so it was *expected* to work under 439 MB of Emscripten file
  package. It was never worth finding out: the same model runs natively at
  several times real time with no file package at all, which is what the
  [Speech](#speech) section describes. The web build's path is untouched.

- **Audio needs GStreamer, and without it WebKit does not degrade — it
  crashes.** This is the one that cost real time. In a shell without the
  GStreamer plugins the app starts and renders fine, logs `GStreamer element
  appsink not found`, and then the *first* `new AudioContext()` kills the whole
  WebKit web process: the page vanishes, with only `GStreamer-CRITICAL`
  assertions on stderr and nothing in the app to catch. WebKitGTK routes Web
  Audio through GStreamer, so this is every spoken word in the app, not just
  `<video>`. `flake.nix`'s `desktop` shell therefore carries
  `gstreamer` + `gst-plugins-{base,good,bad}` + `gst-libav` and exports
  `GST_PLUGIN_SYSTEM_PATH_1_0`; with them, `AudioContext` runs (its clock
  advances), `<audio>` plays a generated WAV, and the criticals are gone. A
  packaged build would have to ship or depend on these.

- **Console noise seen at launch**, none of it fatal: `VM 0x… received
  NeedDebuggerBreak trap` from JavaScriptCore's remote inspector on the first
  dev run. No compositing or dmabuf errors appeared, so
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` was never needed here — reach for it first
  if a window comes up blank on another machine.

## Nix packages the shell needs

`webkitgtk_4_1` (the GTK3/abi-4.1 build `wry` asks pkg-config for — the 6.0/GTK4
one will not satisfy it), `gtk3`, `libsoup_3`, `openssl`, `pkg-config`,
`gdk-pixbuf`, `librsvg`, `cairo`, `pango`, `atk`, `glib`, `cargo-tauri`, and the
five GStreamer packages above. Two are runtime-only and therefore invisible to
the build: `glib-networking` (`GIO_MODULE_DIR`), without which every `https://`
request inside the webview fails, and GStreamer (`GST_PLUGIN_SYSTEM_PATH_1_0`),
whose absence is the crash described above.

The voice adds two more: `rustPlatform.bindgenHook`, because `sherpa-rs-sys`
generates its FFI with bindgen and needs a libclang (`LIBCLANG_PATH`), and
`stdenv.cc.cc.lib` on `LD_LIBRARY_PATH`, because the prebuilt sherpa-onnx and
onnxruntime libraries are linked against an ordinary distribution's libstdc++.
The second is a third runtime-only trap of exactly the shape of the other two:
no build error, and every desktop binary dies at startup with
`libstdc++.so.6: cannot open shared object file`.

## What a shipped version would still need

Not done, and each is real work: bundling (icons, `.deb`/`.AppImage`/`.dmg`,
signing), a CSP, an error path when the database will not open (today `setup`
returns `Err` and the app simply fails to start), SPA fallback for deep routes,
a native menu and window-state persistence, auto-update, and a decision about
whether the desktop build syncs at all — it uses the same `VITE_SYNC_URL` the
web build does, and nothing about that was exercised.

For the voice specifically: shipping sherpa-onnx and onnxruntime as bundled
libraries rather than as a build-time download into `~/.cache` (today
`cargo build` needs the network once per machine), a `cancellable: true` for
the `tts-model` task (the download does not watch for an abort, so the tray
still says "Stop watching"), and macOS/Windows, where none of the linking above
has been tried.
