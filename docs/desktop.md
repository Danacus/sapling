# Desktop (Tauri v2) — a spike

Contracts: `.claude/rules/desktop.md`, `.claude/rules/core.md`.
Code: `crates/sapling-desktop/`, `src/lib/db/tauri.ts`, `src/lib/tts/native.ts`,
`src/lib/platform.ts`.

**This is a spike, not a product.** It exists to answer one question — can the
Rust persistence core run natively over a SQLite file behind the *existing*
domain protocol, with the same SvelteKit app on top? It can, and the app boots
to onboarding through it. It also has to: WebKitGTK has no OPFS
(`navigator.storage.getDirectory` is `undefined`), so the browser's sqlite-wasm
Worker cannot boot in this webview at all, and the native core is not a
performance choice here but the only database the app has. It carries a second
native capability for the same reason, the voice — both synthesizing a clip and
playing it (see [Speech](#speech)): the webview cannot run the browser's
implementation of either. Nothing in the web build or its gates
depends on any of it: the desktop crate is a workspace member but not a
*default* member, and its toolchain lives in a second devShell. CI does check
it — a `desktop` job in `.github/workflows/deploy.yml` runs `pnpm desktop:check`
beside the web job, so a protocol change that breaks the host fails the commit.
It does not gate the deploy: the site has no dependency on the crate.

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

Inside it: `sapling.db` (plus `-wal`/`-shm` — the file is opened in WAL mode,
with `synchronous=NORMAL` beside it, so a commit does not fsync the WAL; an
application crash still loses nothing, a power cut or kernel panic can lose the
last transaction, which is one answered challenge) and `device-id`, one UUID v4
minted on first run. The device id is a *file* and
not a row because it is half of a review's identity and has to survive
`resetData`, which empties the database including `meta`. WebKit puts its own
caches and local storage in the same directory, which is also where the API key
and prefs end up — they are `localStorage` on both hosts, never in the store.

Also inside it, once the voice has been downloaded: `tts/kokoro-multi-lang-v1_1/`,
about 407 MB of ordinary files (see [Speech](#speech)).

Deleting the directory is a factory reset.

If the directory cannot be created or `sapling.db` will not open — a permission
problem, a file where the directory should be, a corrupt header — the app still
starts, and the window shows the same boot-error screen the browser shows when
another tab holds OPFS. The host keeps the reason (`host::Database`), every
persistence command answers it as its `Err`, and `openTauriBackend`'s one probe
read (`poolSize`) is what carries it to `+layout.svelte`. The reason is also
printed to stderr for the terminal that launched the binary.

## What is native and what still goes through the webview

**Native: persistence, synthesis and playback.** `crates/sapling-desktop` opens
the file, lends `sapling-core` the four runtime facts (`deviceId`, the system
clock, `localDay` from the system time zone, UUID v4 ids) and exposes exactly
the three commands `WasmCore` exposes to the database Worker — `dispatch`,
`commit_all`, `derived_schema_version`. `src/lib/db/tauri.ts` is one `invoke`
per `Backend` call, chosen by `backend.ts` when `inTauri()`; every argument
still goes through `toPlain()`, because `client.ts` owns the proxy for both
transports. The voice adds five more commands and is the section below.

`dispatch` and `commit_all` are `async` and wait on `spawn_blocking`, like the
three long voice commands: a synchronous Tauri command runs on the main thread,
and `applyResult` makes three or more persistence calls on every Check. Because
that puts them on a thread pool, `tauri.ts` chains each `invoke` behind the
previous one so calls reach the core in the order the window made them — the
Worker's message queue gives that for free and the pool does not. Symptom if it
is ever removed: a read that follows an un-awaited write occasionally misses it,
on the desktop only.

All of them are host capabilities in the same narrow sense — a file, text-in
audio-out, and audio-in sound-out. None carries a merge rule, a lesson, or a
language.

**Everything else is the same web app in a webview**: the UI, the LLM call to
OpenRouter, the reading and conversation layers, the romanizer, and every
sound that is not speech — the reader's `<video>` and the YouTube frame still
play through WebKitGTK's GStreamer pipeline. There is no native menu, no tray,
no auto-update, no file dialog and no deep-link handling. The window is one
`main` window loading `/`.

Dictation is the exception: WebKitGTK exposes neither `SpeechRecognition`
constructor, so `dictationAvailable()` is false and the control never renders.
`content.md` already says the fallback is typing — on this host it is the only
path. `getUserMedia` *is* present, so a recorder-plus-transcription route
would not be blocked by the webview.

**No CSP.** `app.security.csp` is `null`, matching the web deploy, which sets
none either and for a load-bearing reason (`deploy.md`: the YouTube iframe API
and the `youtube-nocookie` frame). Tauri's default is to inject one; turning it
off is a deliberate spike shortcut, and a shipped build should set a policy that
names those two origins rather than inherit this.

**SPA routing.** In a packaged build the app is served from `tauri://localhost`
over the custom protocol, which does *not* fall back to `index.html` the way
`static/_redirects` does. Starting at `/` works and client-side navigation
works; a reload on a deep route would not. Untested, because nothing reloads.

## YouTube, and the page that has to be hosted

**The symptom.** A YouTube-backed reading text plays under `pnpm desktop:dev`
and fails in a release build with YouTube's error 153, "video player
configuration error".

**The cause is the scheme, not the code.** In dev the app is Vite's
`http://localhost:5173`, which YouTube accepts. A release build serves the app
from `tauri://localhost`, and a browser sends no `Referer` for a document on a
custom scheme; YouTube's IFrame API will not configure a player without one.
This is [tauri-apps/tauri#14422](https://github.com/tauri-apps/tauri/issues/14422),
open upstream, and no configuration closes it: `useHttpsScheme` applies to
Windows and Android only, and `tauri-plugin-localhost` (which would serve the
app over a real `http://` origin) makes Tauri treat the page as untrusted and
drops the IPC every persistence command rides on.

**The fix is one hosted document.** `embed/youtube.html` runs the app's *own*
`youtubePlayer` — imported from `src/lib/media/youtube.ts`, not copied — on a
real HTTPS origin, and the desktop app frames it and drives it over
`postMessage`:

```
tauri://localhost/                          the app, unchanged — IPC intact
 └─ iframe → https://<embed host>/youtube.html?v=ID     a real network fetch
     └─ iframe → https://www.youtube-nocookie.com/…     a referer YouTube takes
```

`Player`'s five verbs and a clock are what crosses (`play`, `pause`,
`seek {ms}` down; `ready`, `time {ms, playing}`, `fail {message}` up), so the
reader and the subtitle-following logic are untouched and never learn which
player they got — `src/lib/media/youtube-host.ts` chooses, gated on
`inTauri()`. `.claude/rules/media.md` is the contract; `embed-protocol.ts`
carries the reasoning in full.

**It is deliberately not in `static/`.** Anything there is precached by the
service worker and copied into the desktop bundle, so it would ship inside the
app and be served over `tauri://localhost` — the exact scheme the page exists to
escape — from the origin that holds the learner's database. The page is meant to
be framed by anything, so it lives on a throwaway origin of its own.

**Configuring it.** `VITE_YOUTUBE_EMBED_URL` is the page's full URL, read at
build time (`src/lib/media/embed-url.ts`, the same shape as `VITE_SYNC_URL`):

```sh
pnpm embed:dev      # the page alone, on Vite's next free port
pnpm embed:build    # -> embed/dist/, which the deploy workflow uploads
```

A desktop build with it unset is a supported configuration: a YouTube text says
that the embed page is not configured, in the video's place, and the text stays
readable — the same degradation every other player failure has. `pnpm
desktop:dev` takes the framed path too, so put the variable in your `.env` to
work on it; testing the path that ships is the point.

Deploying it is a second Cloudflare Pages project — see `.claude/rules/deploy.md`
for the workflow step, the repository variables, and why the page must stay
frameable (no `X-Frame-Options`, no `frame-ancestors`: the framer's origin is a
custom scheme no allowlist can name).

**Pause lands a second or two late on this host, and that is the engine.** It
happens whether the pause comes from the app's button or from a click on the
picture, and the click case never touches Sapling's code; the same lag
reproduces in GNOME Web on the embed page opened directly, where Firefox pauses
instantly. It is WebKitGTK's GStreamer Media Source Extensions pipeline, there
is no knob for it in the app, and it is not the `postMessage` bridge — do not
re-investigate the bridge for this symptom.

## Speech

**Why any of this is native.** The browser runs Kokoro as sherpa-onnx compiled
to WASM in a Worker, and that path cannot exist here: the engine is a 439 MB
Emscripten *file package* whose byte offsets are baked into vendored glue, and
this webview has no `SharedArrayBuffer`. So synthesis moved to Rust.

**And so did playback**, for a separate reason. `<audio>` over a blob does play
correctly here, but it builds a fresh GStreamer pipeline per clip: the first
sample lands about a second after `play()` and the window stalls while the
pipeline is built, on every spoken word. Web Audio is the obvious way to keep
one pipeline for the session, and in this webview it is unusable — noise or
silence depending on the run, with nothing logged and nothing to catch. So the
clip goes back over the IPC and rodio plays it on one output stream the host
holds open. **Only speech moved** — the reader's
`<video>` and the YouTube frame still go through GStreamer, and `src/lib/tts/`'s
`<audio>` path is still what the web build runs and still this host's fallback.

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

**The commands**, and there are only five:

| command | answers |
|---|---|
| `tts_status()` | model name, installed, bytes on disk, bytes a fresh download costs, whether the engine is warm |
| `tts_download()` | nothing; idempotent, verifies, emits `tts://model-progress` |
| `tts_synthesize(text, sid, speed)` | a complete WAV file as a binary IPC payload |
| `tts_play(<raw body>)` | nothing, once the clip has finished playing or been stopped |
| `tts_stop()` | nothing; cuts the clip off, which is what makes the pending `tts_play` return |

A clip crosses as bytes in both directions and never as JSON. `tts_synthesize`
returns `tauri::ipc::Response`, not a `Vec<u8>`, and `tts_play` takes a raw body
(`tauri::ipc::Request` matched against `InvokeBody::Raw`; `native.ts` invokes it
with a `Uint8Array`) rather than a field: ~150 KB of PCM as an array of decimal
digits is megabytes of text to serialize on the window thread and to parse on
the other side, for audio already in the right format. It takes bytes rather
than text because the clip caches are the window's; if they ever move to the
host this becomes `tts_speak(text, sid, speed)` and nothing else changes shape.

`tts_download`, `tts_synthesize` and `tts_play` are `async` and run their work
on `spawn_blocking`, for the reason the persistence commands do — a synchronous
Tauri command runs on the main thread, and a second of inference there is a
frozen window, as is a whole clip's playing time. `tts_stop` stays synchronous:
it posts one message and waits for nothing, and it is on the path to every new
phrase.

The engine is built on the first phrase and kept for the life of the process,
behind a `Mutex` because sherpa-onnx promises nothing about concurrent
generation. The **output stream** is the same idea one layer down: opening a
device per clip would put back exactly the latency this replaced, so the process
opens one and keeps it — on the first clip, not at boot, so a learner who never
taps 🔊 never holds a device open. It lives on a thread of its own because
rodio's `MixerDeviceSink` holds a `cpal::Stream`, which is `!Send` on ALSA, the
same shape of problem `Core` has and the same answer (`host.rs`). `tts_play`
does not wait *on* that thread — it waits on a channel the thread drops when
the clip ends, is stopped, or is replaced by a newer clip — because a thread
blocked on a clip could not answer `tts_stop`. A second `tts_play` cuts the
first off, which is what makes a second tap on 🔊 interrupt the first word.

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
- **A different player, and a fallback for it.** Nothing above the seam changed
  — `speak()` still resolves when the clip finishes — but `playClip` sends the
  bytes to `tts_play` instead of building an `<audio>`. If the host answers that
  it has **no output device**, that is latched for the session and warned about
  once, and every clip after it goes through the element path, which works and
  is merely slow; if the host refuses one *clip*, only that clip falls back.
  Neither is visible in Settings, because neither is a choice a learner makes.

Synthesis runs at several times real time on an ordinary desktop CPU, and that
is what every "is this fast enough" decision above rests on — the engine load,
the missing clip cache, the download bar. `tests/voice.rs` and
`tests/playback.rs` print the current numbers on the machine that runs them.

Synthesis is **not** bit-reproducible: ONNX reduces in whatever order its
threads finish, so the same phrase twice differs in the low bits and by a few
samples of length. Harmless — clips key on text, speaker and speed, so a
learner hears one rendering — but do not write a test that expects equal bytes.

fp32 ships on both hosts. The int8 Kokoro build's all-`NaN` samples are a bug in
the *WASM* build (`models.ts`, sherpa-onnx#2236) and do not reproduce natively,
but one model means one sound on both hosts, and 218 MB is not reason enough for
a second answer to "what does this word sound like".

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

## What the webview cannot do

Four limits shape everything above. They are facts about WebKitGTK on a page
loaded from the real `tauri://localhost` origin, not about Sapling; the runs
behind them are in ffacf14, f78eff6 and 3f41c84.

- **No OPFS and no `SpeechRecognition`**, the two absences the sections above
  are built around: persistence is native because the sqlite-wasm Worker cannot
  boot here, and dictation has no input method. `SharedArrayBuffer` is absent
  too, which is half of why the browser's sherpa TTS wasm has no path here.

- **Audio needs GStreamer, and without it WebKit does not degrade — it
  crashes.** In a shell without the GStreamer plugins the app starts and renders
  fine, logs `GStreamer element appsink not found`, and then the *first*
  `new AudioContext()` kills the whole WebKit web process: the page vanishes,
  with only `GStreamer-CRITICAL` assertions on stderr and nothing in the app to
  catch. WebKitGTK routes Web Audio through GStreamer, not just `<video>`.
  `flake.nix`'s `desktop` shell therefore carries `gstreamer` +
  `gst-plugins-{base,good,bad}` + `gst-libav` and exports
  `GST_PLUGIN_SYSTEM_PATH_1_0`; with them, `AudioContext` constructs, `<audio>`
  plays a generated WAV, and the criticals are gone. A packaged build would have
  to ship or depend on these — speech no longer needs them, but the reader's
  `<video>` and the YouTube frame still do.

- **With the plugins present, the audio *output* is still not usable for
  speech**, which is why playback is the host's ([Speech](#speech)). It is a
  separate fact from the crash above: nothing crashes and nothing logs, the
  element path is merely a second late and Web Audio plays noise or silence.
  **Do not re-attempt Web Audio here**, and do not "simplify" the desktop back
  to `<audio>`: it is the fallback on purpose.

- **Cross-origin `fetch` works.** OpenRouter and the TTS model mirror both
  answer normally with `type: "cors"`, so the API key path needs no Rust-side
  HTTP proxy and no `tauri-plugin-http`.

If a window comes up blank on another machine, reach for
`WEBKIT_DISABLE_DMABUF_RENDERER=1` first; no compositing or dmabuf errors have
appeared here, so it has never been needed.

## Nix packages the shell needs

`webkitgtk_4_1` (the GTK3/abi-4.1 build `wry` asks pkg-config for — the 6.0/GTK4
one will not satisfy it), `gtk3`, `libsoup_3`, `openssl`, `pkg-config`,
`gdk-pixbuf`, `librsvg`, `cairo`, `pango`, `atk`, `glib`, `cargo-tauri`, and the
five GStreamer packages above. Two are runtime-only and therefore invisible to
the build: `glib-networking` (`GIO_MODULE_DIR`), without which every `https://`
request inside the webview fails, and GStreamer (`GST_PLUGIN_SYSTEM_PATH_1_0`),
whose absence is the crash described above.

The voice adds three more: `rustPlatform.bindgenHook`, because `sherpa-rs-sys`
generates its FFI with bindgen and needs a libclang (`LIBCLANG_PATH`);
`stdenv.cc.cc.lib` on `LD_LIBRARY_PATH`, because the prebuilt sherpa-onnx and
onnxruntime libraries are linked against an ordinary distribution's libstdc++;
and `alsa-lib`, which rodio's cpal backend runs pkg-config for at build time.
The second is a third runtime-only trap of exactly the shape of the other two:
no build error, and every desktop binary dies at startup with
`libstdc++.so.6: cannot open shared object file`. `alsa-lib` is the opposite and
therefore the easy one — it fails loudly at build time, and at *runtime* on
NixOS nothing further is needed, because the ALSA default device reaches
PipeWire through its ALSA plugin.

## What a shipped version would still need

Not done, and each is real work: bundling (icons, `.deb`/`.AppImage`/`.dmg`,
signing), a CSP, SPA fallback for deep routes,
a native menu and window-state persistence, auto-update, and a decision about
whether the desktop build syncs at all — it uses the same `VITE_SYNC_URL` the
web build does, and nothing about that was exercised. A CSP here would have to
allow framing the embed host as well as the two YouTube origins, since a shipped
desktop build reaches YouTube only through that frame.

For the voice specifically: shipping sherpa-onnx and onnxruntime as bundled
libraries rather than as a build-time download into `~/.cache` (today
`cargo build` needs the network once per machine), a `cancellable: true` for
the `tts-model` task (the download does not watch for an abort, so the tray
still says "Stop watching"), and macOS/Windows, where none of the linking above
has been tried.
