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
It does not gate the deploy: the site has no dependency on the crate. The same
crate is also built as a signed release APK by an `android` job, which is
likewise CI-only and gates nothing — see [Android](#android).

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

The two Android scripts are the exception and want the *default* shell plus a
rustup toolchain, an SDK and an NDK, which is why the APK is only ever built in
CI (see [Android](#android)):

```sh
pnpm desktop:android:init   # rewrite gen/android — needs the SDK, NDK and rustup
pnpm desktop:android        # the release APK, over a `build/` that already exists
```

**`gen/android` is committed, so the init is not part of anyone's loop** — it is
how the tree was first written and how it would be rebuilt for a new Tauri
version, and it *overwrites* the three edits [Android](#android) describes.

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
| Android | `/data/data/app.sapling.desktop/` (`Context.dataDir`, private to the app) |

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

**Native: persistence, synthesis, playback and recognition.**
`crates/sapling-desktop` opens the file, lends `sapling-core` the four runtime
facts (`deviceId`, the system clock, `localDay` from the system time zone, UUID
v4 ids) and exposes exactly the three commands `WasmCore` exposes to the
database Worker — `dispatch`, `commit_all`, `derived_schema_version`.
`src/lib/db/tauri.ts` is one `invoke` per `Backend` call, chosen by
`backend.ts` when `inTauri()`; every argument still goes through `toPlain()`,
because `client.ts` owns the proxy for both transports. Speech adds eight more
commands and is the section below.

`dispatch` and `commit_all` are `async` and wait on `spawn_blocking`, like the
long speech commands: a synchronous Tauri command runs on the main thread,
and `applyResult` makes three or more persistence calls on every Check. Because
that puts them on a thread pool, `tauri.ts` chains each `invoke` behind the
previous one so calls reach the core in the order the window made them — the
Worker's message queue gives that for free and the pool does not. Symptom if it
is ever removed: a read that follows an un-awaited write occasionally misses it,
on the desktop only.

All of them are host capabilities in the same narrow sense — a file, text-in
audio-out, audio-in sound-out, and samples-in sentence-out. None carries a merge
rule, a lesson, or a language.

**Everything else is the same web app in a webview**: the UI, the LLM call to
OpenRouter, the reading and conversation layers, the romanizer, and every
sound that is not speech — the reader's `<video>` and the YouTube frame still
play through WebKitGTK's GStreamer pipeline. **The microphone is in that list**:
`getUserMedia` works in both webviews, so the audio for dictation is captured in
the window and only the *recognition* is native. There is no native menu, no
tray, no auto-update, no file dialog and no deep-link handling. The window is
one `main` window loading `/`.

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

Speech goes both ways on this host and it is **one feature**, `speech`, on by
default. Synthesis and recognition are the same dependency set — sherpa-onnx,
and the download, checksum and unpack of a pinned model archive — over the same
`src/models.rs`, and the only thing either has to itself is the desktop's
player. It was called `tts` until dictation arrived; splitting it back into two
would put `any(feature = …)` on the shared module and make four build
configurations nobody would ever check.

### Synthesis

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

URL, size and hash are one constant, `KOKORO` in `src/models.rs` — the module
both models share ([the model install](#the-model-install)).

**The commands**, and there are eight — six on every target, the two players on
desktop targets only ([speech on Android](#speech-on-android)):

| command | answers |
|---|---|
| `tts_status()` | model name, installed, bytes on disk, bytes a fresh download costs, whether the engine is warm, **whether this host plays** |
| `tts_download()` | nothing; idempotent, verifies, emits `tts://model-progress` |
| `tts_synthesize(text, sid, speed)` | a complete WAV file as a binary IPC payload |
| `tts_play(<raw body>)` | nothing, once the clip has finished playing or been stopped |
| `tts_stop()` | nothing; cuts the clip off, which is what makes the pending `tts_play` return |
| `asr_status()` | model name, installed, bytes on disk, bytes a fresh download costs, whether the recognizer is warm, **which languages it covers** |
| `asr_download()` | nothing; idempotent, verifies, emits `asr://model-progress` |
| `asr_transcribe(<raw body>)` | one sentence, from one utterance of 16 kHz 16-bit mono PCM |

Audio crosses as bytes in every direction and never as JSON. `tts_synthesize`
returns `tauri::ipc::Response`, not a `Vec<u8>`, and `tts_play` and
`asr_transcribe` take a raw body (`tauri::ipc::Request` matched against
`InvokeBody::Raw`; `native.ts` invokes them with a `Uint8Array`) rather than a
field: ~150 KB of a clip, or ~320 KB of a ten-second utterance, as an array of
decimal digits is megabytes of text to serialize on the window thread and to
parse on the other side, for audio already in the right format. `tts_play` takes
bytes rather than text because the clip caches are the window's; if they ever
move to the host this becomes `tts_speak(text, sid, speed)` and nothing else
changes shape.

Everything but `tts_stop` is `async` and runs its work on `spawn_blocking`, for
the reason the persistence commands do — a synchronous Tauri command runs on the
main thread, and a second of inference there is a frozen window, as is a whole
clip's playing time. The two `_status` commands wait for no lock at all, but
they do read the disk, from a screen a learner opens mid-phrase. `tts_stop`
stays synchronous: it posts one message and waits for nothing, and it is on the
path to every new phrase.

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
  bytes to `tts_play` instead of building an `<audio>`, *when the host says it
  plays* (`tts_status`'s `playback`; false on Android, where the element path is
  used and nothing is attempted). If a host that does play answers that it has
  **no output device**, that is latched for the session and warned about once,
  and every clip after it goes through the element path, which works and is
  merely slow; if the host refuses one *clip*, only that clip falls back. None
  of it is visible in Settings, because none of it is a choice a learner makes.

Synthesis runs at several times real time on an ordinary desktop CPU, and that
is what every "is this fast enough" decision above rests on — the engine load,
the missing clip cache, the download bar. `tests/voice.rs` and
`tests/playback.rs` print the current numbers on the machine that runs them.
`playback.rs` opens the real default device but plays **silence** through it —
zero samples take exactly as long to consume as any others, so the timings are
real and the check is inaudible; its one audible clip is `#[ignore]`d and is run
by hand (`cargo test -p sapling-desktop --test playback -- --ignored`) when the
question is whether this machine makes a noise.

Synthesis is **not** bit-reproducible: ONNX reduces in whatever order its
threads finish, so the same phrase twice differs in the low bits and by a few
samples of length. Harmless — clips key on text, speaker and speed, so a
learner hears one rendering — but do not write a test that expects equal bytes.

fp32 ships on both hosts. The int8 Kokoro build's all-`NaN` samples are a bug in
the *WASM* build (`models.ts`, sherpa-onnx#2236) and do not reproduce natively,
but one model means one sound on both hosts, and 218 MB is not reason enough for
a second answer to "what does this word sound like".

### Dictation

**Why this one is native too.** `src/lib/asr/` had exactly one backend, the Web
Speech API, and neither of this crate's webviews has it: WebKitGTK exposes no
`SpeechRecognition` constructor at all, and neither does Android's WebView. So
on both hosts `dictationAvailable()` was simply `false` and the microphone
button never rendered. Where the browser engine *does* exist it is also a round
trip to a vendor, which a local-first app should not need for a sentence the
learner is about to type anyway.

**Nothing above the seam moved.** `listen(language, handlers)` is unchanged:
`undefined` still means no handler will ever fire, a returned session still ends
in exactly one `onEnd`, `no-speech` and abort are still silent, and the
transcript still lands in the composer for the learner to read and send.
`dictationAvailable` is the one signature that changed, and only to become
asynchronous and to take the language — because the answer is now the host's,
and the host recognizes some languages and not others.

**The model.** SenseVoice small, int8, from k2-fsa's release assets:

```
https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
163,002,883 B   sha256 7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e
```

`SENSE_VOICE` in `src/models.rs`, and it unpacks to 240 MB in `<app-data>/asr/`.
Two choices in that line are worth stating. **int8, where the voice ships fp32**
— the voice's reason is that one model must sound the same on both hosts and the
browser's fp32 is the one that works, and there is no browser recognizer for
this to agree with, so what is left is 239 MB of weights against 938 MB for a
difference nobody has been able to hear in a dictated sentence. And **the
int8-*only* archive**, not the combined release asset: both unpack the same
`model.int8.onnx`, but the combined one is 1,047,870,769 B because it carries
the fp32 export as well — a gigabyte downloaded to keep a sixth of it.

**Which languages route here** is the host's answer, not a list on the web side:
`asr_status` carries `languages` (`zh`, `en`, `ja`, `ko`, `yue`), `src/lib/asr/`
resolves the learner's free-text language through the same `bcp47For` the voice
uses, takes the primary subtag, and asks whether it is in that list. Everything
else keeps Web Speech where it exists and gets no button where it does not. So
swapping the model is a `ModelSpec` change plus its `LANGUAGES` constant, and
nothing at all in the window.

The recognizer is created once, with `language: "auto"`. That field is fixed at
create time, so telling it which language to expect would mean rebuilding a
239 MB ONNX session every time a learner changed target language, in exchange
for a hint on a model whose whole selling point is identifying those five
itself. `use_itn` is on, which is what puts the punctuation in and writes "fifty"
as `50`: the transcript goes into a composer to be read and sent, so it should
look like something a person would type.

**The audio is captured in the window**, on both hosts, and that is the one
place this differs in shape from the voice. `getUserMedia` works in both
webviews, permissions are the browser's, and the desktop's reason for taking
*playback* over — a fresh GStreamer pipeline per `<audio>` clip — has no
equivalent on the way in. So the graph is `getUserMedia` → `AudioWorkletNode`
(`static/asr/pcm-worklet.js`, plain JS outside Vite for the reason
`sherpa-worker.js` is) and it stops there: the node is built with
`numberOfOutputs: 0`, so **nothing is connected to `AudioContext.destination`
and no output device is ever opened**. That is deliberate rather than tidy —
Web Audio *output* on this host plays noise or silence, and a recorder that had
to reach the speakers to be pulled is the one shape that could make a sound
while the learner is talking. The context is asked to open at 16 kHz so the
browser's own resampler does the work; a browser that refuses the option gets
resampled by `src/lib/asr/pcm.ts` instead, which averages the decimation window
rather than dropping samples.

**Phase one is button-stopped.** One utterance, one `onTranscript(text, true)`,
one `onEnd()`. No streaming, no VAD, no partial transcripts. sherpa-onnx ships
Silero VAD and streaming Zipformer transducers and either would live here; the
handler shape already has room for partials, and the host would grow
`asr_start` / `asr_feed` / `asr_stop` plus an event. Nothing in this slice is in
its way.

**Silence is not empty, and the gate for it is in the window.** Half a second of
digital silence comes back from SenseVoice as `嗯。` — it fills a hole rather
than declining to. The host stays honest and reports what the recognizer said;
the contract that `no-speech` ends silently is `$lib/asr`'s, so `pcm.ts` refuses
to send an utterance shorter than 0.2 s or one whose loudest sample is under
about −46 dBFS. That catches a muted or unplugged microphone, which produces
exact zeros. It deliberately does *not* try to catch a learner who said nothing
into a live microphone: that capture contains real room noise, telling it from a
quiet word is a VAD's job, and the result is a filler word in the composer —
precisely the failure the composer exists to absorb.

**Measured, on the model above, on an ordinary desktop CPU** (a debug build, and
`tests/dictation.rs` prints these on the machine that runs it): 5.6 s of
Mandarin transcribed in 0.98 s *including* the engine load, and 7 s of English
and 5 s of Cantonese in about 0.2 s each once warm — 30-odd times real time. The
load is fast enough that there is no warm-up command and no case for one. **On a
phone these numbers are unknown**, like the voice's.

`tests/dictation.rs` is `tests/voice.rs`'s shape and its contract: it transcribes
the `test_wavs/` the model archive ships and asserts what came out, and it
**skips itself** with a printed reason when there is no model, because a
checkout without one is normal and `pnpm desktop:check` must be green in it. To
give a machine one:

```sh
nix develop .#desktop -c cargo test -p sapling-desktop --test dictation -- --ignored --nocapture
```

which downloads it into the same place the app does, so the app has it too.

### The model install

Both models come down the same path, and it is `src/models.rs`: one `ModelSpec`
per model pinning URL, exact byte size, sha256 and the files that have to exist
for it to be usable, plus the install those constants describe. It used to be
`tts/model.rs` and belonged to the voice; two callers is where copying it stops
being cheaper than sharing it.

An archive is streamed to `<app-data>/<tts|asr>/*.part`, hashed as it lands,
verified against both numbers, and only then unpacked — into a `.partial`
sibling of the model directory, whose contents are checked and then moved into
place by a single rename. **The live model path is therefore always absent or
whole**, which is what lets a lesson opened mid-download load the engine safely:
sherpa-onnx over a half-written `espeak-ng-data` does not fail, it calls
`exit(-1)`. A failure or a crash leaves the part file and the `.partial` tree,
both swept by the next install. Download and unpack each report progress against
the archive's own size, so the bar covers the whole minute rather than sitting
at 100% through bzip2 — `$lib/tasks/kinds/model-download` folds those two passes
into one line that never goes backwards, for `tts-model` and `asr-model` alike.

Progress rides on **two channels**, `tts://model-progress` and
`asr://model-progress`, rather than one carrying a model name: the two installs
are separable at the source, so a shared channel would only mean every listener
filtering a stream it never wanted.

**How sherpa-onnx is linked, and whose crate it is.** `sherpa-onnx` — the safe
Rust wrapper k2-fsa publishes from the sherpa-onnx repository itself, over its
own `sherpa-onnx-sys`. The version *is* the sherpa-onnx tag: `sherpa-onnx-sys`
1.13.7's build script downloads `sherpa-onnx-v1.13.7-<platform>-lib.tar.bz2`
from the release of that name into `target/sherpa-onnx-prebuilt/`, so the
pregenerated bindings and the library they call can never come from two
different tags. **The dependency is therefore pinned `=1.13.7`**, not `^`: a
config struct that grew a member between tags is a silent ABI mismatch rather
than a compile error, and a lockfile update must not be able to cause one. The
same reason still rules out pointing it at nixpkgs' `sherpa-onnx`, which tracks
its own version.

Three consequences, and each of them removed something that used to be here:

- **Static by default on desktop** (the crate's `static` feature; `shared` is
  the opt-out, and Android and iOS are forced to shared whatever the features
  say). So there is no `.so` beside the binary, no `-Wl,-rpath,$ORIGIN` in
  `build.rs`, and no libstdc++ on the devShell's `LD_LIBRARY_PATH` — libstdc++
  is a direct `NEEDED` of the binary now, which nix's linker wrapper resolves
  by itself. Verified by running the crate's test binaries with
  `LD_LIBRARY_PATH` unset.
- **Pregenerated bindings**, so nothing in this repository runs bindgen and no
  shell or CI job needs a libclang. `rustPlatform.bindgenHook` is gone from the
  `desktop` devShell.
- **No `unsafe` anywhere in the crate** — `lib.rs` `forbid`s it. `tts::kokoro`
  used to be the one exception: the third-party `sherpa-rs` wrapper built its
  rule-FST path as `raw.rule_fsts.map(|v| v.as_ptr())`, and `Option::map`
  *consumes* the `CString`, so sherpa-onnx read freed memory and returned a null
  engine for every configuration with FSTs — which is every configuration we
  want, since `date-zh.fst` and `number-zh.fst` are what keep "2026" from coming
  out as English digits inside a Chinese sentence. The official wrapper's
  `OfflineTts::create` keeps every `CString` in a `Vec` across the call, so the
  twenty lines of hand-rolled FFI are gone.

`dict_dir` is still passed (`dict/` from the model archive), though from
sherpa-onnx v1.12.15 the Chinese frontend segments with a phrase matcher over
the lexicon and an unused dict dir only logs that it is unused. It was
mandatory on the v1.12.9 C API this host started with; it stays because the
directory ships in the archive anyway and is one of the files the installed
check names, and re-deciding what "installed" means is not worth an argument
the library ignores.

## Android

The same crate also builds as an Android app. It is a spike inside a spike:
**nobody here has an Android SDK**, so the build exists only as the `android`
job in `.github/workflows/deploy.yml`, and nothing in the app or its gates
depends on it. Like `desktop`, it runs beside `build` and gates no deploy. It
has been installed on a phone once (Android 15) — see [What the phone
said](#what-the-phone-said). The APK is a **release** build signed with a stable
key ([Signing](#signing)), so each one installs over the last.

**What the job does**, in order: installs and builds the web bundle inside the
flake's devShell exactly as `build` does (`pnpm install --frozen-lockfile`,
`pnpm build`); checks that the committed `gen/android` is there; writes the
signing key out of the secrets ([Signing](#signing)); builds the APK with the
Tauri CLI; and verifies the signature on what came out. Three seams are worth
knowing:

- **The Rust half uses rustup, not nix.** nixpkgs' rustc carries no Android
  target std and `androidenv` is unfree and enormous, so `dtolnay/rust-toolchain`
  installs `aarch64-linux-android` and the APK step prepends rustup's shims to
  `PATH` *inside* `nix develop`. Everything else — node, pnpm, the
  Tauri CLI — is still the flake's. The NDK is the runner image's
  (`ANDROID_NDK_LATEST_HOME` → `NDK_HOME`), Java is `actions/setup-java`, and
  the SDK platform and build-tools are installed explicitly rather than left to
  a Gradle auto-download.
- **The web bundle is built first, so Tauri must not build it again.**
  `beforeBuildCommand` is `pnpm build`, which needs the wasm target, `lld` and
  the pinned wasm-bindgen; under rustup it would fail. `pnpm desktop:android`
  therefore passes `--config '{"build":{"beforeBuildCommand":""}}'` — an empty
  hook is a skipped hook — and the script's contract is "the bundle in `build/`
  is already there".
- **Every step goes through a package.json script, and that is load-bearing.**
  `tauri android init` writes the command Gradle will use to call the CLI back
  (once per ABI) out of *how it was itself invoked*: with a package manager in
  the environment it writes `pnpm tauri android android-studio-script`, and
  without one it writes `node tauri …`, which is not a runnable command and
  fails minutes later inside Gradle. That command is now **committed**, in
  `gen/android/buildSrc/.../BuildTask.kt`, so it was written once — by
  `pnpm desktop:android:init`, which sets `PNPM_PACKAGE_NAME` — and it says
  `pnpm`, with no path from the machine that ran it. `"tauri": "tauri"` exists
  in `package.json` for Gradle to call — **do not delete it**; it looks unused
  and is not. pnpm finds it by walking up from `crates/sapling-desktop`.

**One ABI, `arm64-v8a`.** Every extra one is the whole dependency tree compiled
again for a spike nobody has a device farm for; `--target aarch64` in
`pnpm desktop:android` is the single place to widen it, and the flavor stays
`universal` either way.

**The APK** lands at
`crates/sapling-desktop/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
and is uploaded as the workflow artifact `sapling-android-apk`. It is signed
with the key [Signing](#signing) describes, so it installs *in place* over the
one already on the phone — no uninstall, and the app's data survives:

```sh
unzip sapling-android-apk.zip           # what GitHub hands back
adb install -r app-universal-release.apk
```

The step before that upload is `apksigner verify --print-certs` over the same
file, so an APK that came out unsigned fails CI and the log always names the
certificate that signed the one it hands out.

### Signing

Android identifies an app by the certificate that signed it: two builds signed
by different keys are two different apps to a device, and installing the second
means uninstalling the first. That is what a debug build costs — Gradle mints a
throwaway keystore per machine — so the APK is a release build signed with **one
key that does not change**.

**The key lives outside this repository**, in
`~/.config/sapling/android-signing/` (mode 700) on the machine that minted it:

| file | what it is |
|---|---|
| `sapling-upload.jks` | PKCS12, RSA 2048, alias `sapling`, valid 10000 days from 2026-09-07 |
| `keystore.properties` | the alias and the password, in the shape Gradle reads |
| `README` | the same summary as this section, next to the key |

Back it up. Nothing in the repo can regenerate it, and losing it means every
device uninstalls once, forever after.

**CI gets it as four repository secrets**, and the `Write the Android signing
key` step turns them back into the two files Gradle wants —
`gen/android/sapling-upload.jks` and `gen/android/keystore.properties`, both
gitignored:

| secret | value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 sapling-upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `sapling` |
| `ANDROID_KEY_PASSWORD` | the same password (PKCS12 requires the two to be equal) |

**An absent keystore may not fail the build.** A fork has no secrets, and a
release build is the only build there is now, so `app/build.gradle.kts` falls
back to Gradle's debug key and says so in one lifecycle line. Debug-signed
rather than unsigned on purpose: an unsigned release APK is named
`app-universal-release-unsigned.apk`, and the workflow's artifact path names one
exact file with `if-no-files-found: error`.

**Rotating** means a new keystore (`keytool -genkeypair -storetype PKCS12
-keyalg RSA -keysize 2048 -validity 10000 -alias sapling`), the four secrets
re-uploaded, and **one uninstall on every device** — the new certificate is a
new app identity. Keep the old keystore until every device has been through it.

**This is a sideload key.** It signs APKs that are installed with `adb`, and
that is the whole of its job. If Sapling ever went to Google Play, Play App
Signing would issue the *app's* signing certificate and hold it; this key would
become the upload key only, and the APKs on devices would have to be reinstalled
against Play's certificate.

### What else release changes

**`devtools` is on** (`tauri`'s feature, in `Cargo.toml`), because a release
webview otherwise has no inspector at all and `chrome://inspect` over adb is the
only console this app has on a phone. It is a spike's setting: it comes off when
the app is distributed.

**Release is not debug with a signature on it**, and three of the differences
are worth knowing because the one APK that has been on a phone was a debug
build. The generated project's release type sets `isMinifyEnabled = true`, so R8
shrinks the Kotlin side (Tauri writes `proguard-tauri.pro` per build, which is
what keeps the classes JNI reaches by name). The workspace's `[profile.release]`
is tuned for the wasm core — `opt-level = "s"`, LTO, one codegen unit,
`panic = "abort"` — and the Android cdylib is built under it too, which makes
this the slowest build in CI by a wide margin. And the manifest's
`usesCleartextTraffic` placeholder is `"false"` here where debug set it `"true"`;
the app's own assets are served through wry's interceptor and never touch the
network stack, so this is Tauri's template behaving as designed rather than
something to work around.

### The generated project is committed

**`gen/android` is in git** — 42 files, ~320 KB, the Gradle wrapper jar included
— and the root `.gitignore` keeps only `gen/schemas/`, which `tauri-build`
rewrites on every desktop build. This reverses the first decision here
("generate it per CI run"), and the reason is that the app's own icons and its
edge-to-edge fix exist *only* as edits to that tree: there is no config key for
either, and `tauri android init` writes Tauri's defaults back over both. So the
CI job now **checks that the tree is there** and fails with a sentence if it is
not, rather than generating one. What is committed is what a device runs.

Regenerating it — a Tauri upgrade, say — needs an SDK, an NDK *and* rustup,
because `tauri android init` validates the environment and shells out to
`rustup target add` before it writes anything. It never actually *uses* them:
empty directories and a `rustup` that exits 0 are enough, which is how this tree
was written on a machine with no Android tooling at all.

```sh
mkdir -p /tmp/sdk /tmp/ndk /tmp/bin
printf 'Pkg.Revision = 27.2.12479018\n' > /tmp/ndk/source.properties
printf '#!/bin/sh\nexit 0\n' > /tmp/bin/rustup && chmod +x /tmp/bin/rustup
ANDROID_HOME=/tmp/sdk NDK_HOME=/tmp/ndk PATH="/tmp/bin:$PATH" \
  pnpm desktop:android:init
```

After a regeneration, **redo the three edits below** and re-check that nothing
absolute leaked in: `grep -rn '/home/\|/nix/store' crates/sapling-desktop/gen`
should be silent. `BuildTask.kt` is the file to watch, since it embeds the
command Gradle calls the CLI back with.

A CI build does not dirty the tree. Everything `tauri android build` rewrites
per run is covered by the generated project's own nested `.gitignore` files:
`app/tauri.build.gradle.kts`, `app/tauri.properties`, `app/proguard-tauri.pro`,
`app/src/main/assets/tauri.conf.json`, `app/src/main/jniLibs/**/*.so`, the
`generated/` Kotlin sources (`TauriActivity` among them), `build/`, `.gradle/`
and `local.properties`.

### The three edits

**The icons** are the app's, generated from the same 512px source the web build
uses:

```sh
cd crates/sapling-desktop && pnpm exec tauri icon ../../static/icons/icon-512.png
```

It fills `app/src/main/res/mipmap-*/ic_launcher{,_round,_foreground}.png` and
the adaptive-icon pair beside them, and there is no flag to ask it for one
platform — it also writes a desktop and iOS set into
`crates/sapling-desktop/icons/`, which nothing reads (`bundle.icon` points
straight at `static/icons/icon-512.png`, and bundling is off), so that directory
is gitignored and deleted rather than committed. This is the one CLI call that
has to run as `pnpm exec` rather than as a script: a pnpm script would run it
from the repo root, where there is no `tauri.conf.json`. One value in what it
writes is changed by hand — `values/ic_launcher_background.xml` is the app's
paper instead of `#fff`, since the generated foreground is the whole squircle
and white would only ever show as a chip out of its corners.

**The window insets** are `MainActivity.kt`, and they are why the status bar no
longer sits on top of the app. The template calls `enableEdgeToEdge()` and the
project targets SDK 36, so the window is laid out behind the status bar and the
gesture bar. Neither cheap answer works: `android:windowOptOutEdgeToEdgeEnforcement`
switches off the *framework's* enforcement and cannot undo an explicit
`enableEdgeToEdge()`, and it is deprecated and ignored outright for an app
targeting 36 on an Android 16 device; `env(safe-area-inset-*)` is a bet on a
WebView behaviour this repo cannot verify. So the activity applies the
`systemBars() | displayCutout()` insets as padding on its content view — the
`FrameLayout` wry drops the WebView into with `setContentView(webView)` — which
*sizes* the WebView to the safe area and leaves the web app knowing nothing.
`enableEdgeToEdge()` stays, so the window behaves the same way on every API
level from minSdk 24 up. The strip left behind the bars is painted with the
app's paper (`--bg`) by `values/themes.xml`; the night theme keeps Material's
dark background, because what the WebView reports for `prefers-color-scheme`
under a DayNight theme is exactly the sort of thing that needs a device, and a
paper strip under light status-bar icons would hide them. The IME is
deliberately out of the mask — a keyboard that covers a focused input is the
behaviour this host already had, and changing when the WebView resizes is a
change that wants a device to check.

**The microphone permissions** are two `<uses-permission>` lines in
`AndroidManifest.xml`, plus a `<uses-feature … required="false">` so a device
without a microphone can still install. wry's own `WebChromeClient` does the
runtime request and the grant; declaring them is the part it cannot do for
itself, and an undeclared permission is denied with no prompt. The reasoning is
under [Speech on Android](#speech-on-android), and the manifest carries it in a
comment too, since that file is the one a regeneration overwrites.

### Speech on Android

**Synthesis and dictation are native here too; playback is not.** The whole of
[Speech](#speech) applies to the phone unchanged — the same sherpa-onnx, the
same pinned 365 MB Kokoro archive, the same 163 MB SenseVoice archive, the same
`app_data_dir()`, the same six status/download/work commands. What is missing is
`tts_play`/`tts_stop`, and only because of *why* they exist: they were added to
get around WebKitGTK, which builds a fresh GStreamer pipeline per `<audio>` clip
and starts a spoken word about a second late. **Android's WebView is Chromium**,
where an `<audio>` element over a blob is the ordinary path and works, so the
clip stays in the window and rodio — whose cpal backend wants an ALSA that is
not there anyway — is the one dependency still declared for desktop targets
only. `tts::play` and its two commands are gated
`all(feature = "speech", desktop)`; everything else about speech is gated on the
feature alone and builds everywhere. One configuration, not two.
`cargo tree -p sapling-desktop --target aarch64-linux-android` is how that is
checked: the Android tree carries sherpa-onnx and the download crates and no
`rodio` or `cpal` at all.

**The microphone permission is the one Android-shaped piece of dictation**, and
it turned out to be one line of manifest rather than a `MainActivity` override.
wry 0.55.1's own `RustWebChromeClient.onPermissionRequest` (in the crate's
`src/android/kotlin/`) already handles
`android.webkit.resource.AUDIO_CAPTURE`: it launches a runtime request for
`RECORD_AUDIO` **and** `MODIFY_AUDIO_SETTINGS` and grants the page only if every
one comes back granted. wry installs that client itself
(`main_pipe.rs`'s `setWebChromeClient`), so `TauriActivity` inherits it and
nothing here has to hook anything. What it cannot do is declare the permissions:
Android denies a runtime request for an undeclared permission with no prompt at
all, and because that callback requires *all* of them, the normal-protection
`MODIFY_AUDIO_SETTINGS` has to be declared beside the dangerous `RECORD_AUDIO`
or the whole grant fails silently. Both are now in the committed
`AndroidManifest.xml`, along with `<uses-feature android:name="android.hardware.microphone"
android:required="false" />` so a device without one can still install — dictation
degrades to typing there, which is what it does everywhere else.

**None of that has been on a phone.** The permission flow, whether Chromium's
WebView treats `http://tauri.localhost` as a secure context for `getUserMedia`
(it should — Chromium counts `*.localhost` as potentially trustworthy), and how
fast SenseVoice decodes on a mobile CPU are all unverified. They are the first
things to check on the next APK.

**The window is told, not left to guess.** `TtsStatus` carries a `playback`
boolean (`tts::HOST_PLAYS_AUDIO`, which is `cfg!(desktop)`), `tts.ts` reads it
off the `tts_status` probe it already makes, and a host that answers `false`
goes straight to the element path — no `tts_play` attempt per clip, no warning
per word, and no "no output device" latch. `inTauri()` is still the only
platform test on the web side; everything else about the host is asked of the
host. A shell built with `--no-default-features` has no speech commands at all,
and that still degrades the way a failed synthesis does.

**Getting sherpa-onnx into the APK is the one real piece of work**, and it falls
to `crates/sapling-desktop/build.rs`. `sherpa-onnx-sys` links *shared* on
Android (the `static` feature is ignored there) and downloads
`sherpa-onnx-v1.13.7-android.tar.bz2` into
`target/sherpa-onnx-prebuilt/…/jniLibs/<abi>/` — or is *told* where they are
through `SHERPA_ONNX_LIB_DIR`, which is what CI does, because that crate's own
unpacking of the Android archive is broken in 1.13.7 (see the gotchas) — but
nothing packages what it finds: Tauri's Gradle `RustPlugin` copies exactly one file, the crate's own
`libsapling_desktop.so`. So when `CARGO_CFG_TARGET_OS` is `android`, `build.rs`
copies `libsherpa-onnx-c-api.so` (4.5 MB) and `libonnxruntime.so` (21.7 MB) into
`gen/android/app/src/main/jniLibs/arm64-v8a/`, which the generated project's own
`.gitignore` already covers (`/src/main/jniLibs/**/*.so`). Four things about
that are worth knowing:

- **It is in `build.rs` rather than in CI** so that any `pnpm desktop:android`,
  anywhere, produces an APK that runs.
- **The ordering is not luck.** `sherpa-onnx-sys` declares
  `links = "sherpa-onnx"`, and cargo runs a `links` dependency's build script
  before that of the crate depending on it. Without that key the two build
  scripts would race and a cold cache would lose.
- **No third library.** `readelf -d` on both lists `libandroid`, `liblog`,
  `libm`, `libdl`, `libc` and (for the c-api one) `libonnxruntime` — nothing
  else, so the C++ runtime is statically linked inside them and there is no
  `libc++_shared.so` to fetch from the NDK. Android's loader resolves
  `DT_NEEDED` against the APK's own lib directory, so `libonnxruntime.so` is
  found with no rpath. Both are built with 16 KB `LOAD` alignment, so they are
  fine on Android 15's 16 KB-page devices.
- **The APK is what is checked, not the build script.** Whether cargo reran a
  build script is cargo's business, so a `Check sherpa-onnx reached the APK`
  step greps the finished APK for all three `lib/arm64-v8a/*.so` and fails if
  one is missing, after printing the jniLibs listing and the `readelf` output.

`INTERNET` is in the committed manifest, which the 365 MB download needs; the
download itself goes through `ureq` + rustls with webpki-roots, so there is no
system certificate store to find, and its `.part` staging and single `rename`
are ordinary filesystem operations inside the app's private directory.

**ONNX gets at most four threads on a phone** (`MOBILE_MAX_THREADS`). A desktop
gets `available_parallelism()` entire, because it is one interactive request and
nothing else wants the box; a phone's cores are not interchangeable, and an
eight-thread session split across four fast and four slow cores runs at the pace
of the slow ones while spending the battery of all eight. Four is the usual size
of the fast cluster. **Nobody has measured this on a device** — that number is
the thing to revisit first if synthesis on a phone is disappointing.

Persistence is untouched by any of it: `app_data_dir()` answers
`Context.dataDir` on Android, so `sapling.db`, `device-id` and
`tts/kokoro-multi-lang-v1_1/` and `asr/sherpa-onnx-sense-voice-…/` sit in the
app's own private directory and the host creates it exactly as it does anywhere
else. That does mean the two models are another 647 MB of app data on the phone
if the learner downloads both — which is why each is a separate button in
Settings rather than one "download speech" step.

`bundle.active` being `false` does not get in the way: it is read by
`tauri build` and `tauri info` only, and the APK comes out of Gradle either way.

**Settings needed almost nothing.** The native-voice copy was already nearly
right; two claims that were true of a desktop are not claims about a phone, so
"on every core" and "several times faster than real time" are gone and the rest
stands. `nativeVoice` is still `inTauri()`, and Settings still shows no sign of
which player is in use — that has never been a choice a learner makes.
Dictation added one row beside it, on the same pattern and gated the same way:
it renders only where `asr_status` answered with a download size, so a browser
never sees it.

### What the phone said

The APK has now been sideloaded, once, onto an Android 15 phone. It boots and
the app runs: pages mount, the database opens, and the voice degraded exactly as
designed — that build had none at all, `tts.ts` said so and fell back. **That
observation predates the section above**: no APK carrying the native voice has
been on a device yet, so the phone has never actually spoken, the synthesis
speed there is unknown, and so is what four ONNX threads do to a battery. Three
things came back, and the state of each:

- **The launcher icon was Tauri's**, and is now the app's — [the two
  edits](#the-three-edits).
- **The status bar sat on top of the app**, and no longer does — same section.
- **The settings page reloaded in a loop.** The guard in `+layout.svelte` was
  not a guard: it cleared its own flag as the layout script ran, which is
  *before* the failing import is attempted, so a chunk that fails on every load
  reloaded forever. `$lib/ui/preload-reload` now clears it only when the learner
  navigates somewhere else — `afterNavigate` minus the `enter` the reload itself
  lands on, since the failing import here is fired by an effect *after* Settings
  has mounted and the landing navigation would otherwise clear the flag a
  heartbeat before the failure. A persistent failure now reloads once and then
  surfaces as the ordinary error. **Why the import fails on this host is still
  open**, and the reload is what hid it: the logs show Settings mounting and
  hard-reloading ~150 ms later with nothing printed. The suspect is the one
  dynamic import Settings makes that other visited pages do not — `loadRomanizer`
  → `./zh`, the ~288 KB pinyin-pro chunk — so the handler now logs the failing
  module's URL *before* it reloads, and the next APK's logcat should name the
  file. Nothing calls `preventDefault()` on the event, so Vite still rethrows
  and `loadRomanizer`'s caller still sees its rejection (Settings catches it and
  keeps the stored LLM readings, which is the documented fallback).
- **SvelteKit's service-worker registration fails here**, on every load, with
  "unknown error occurred when fetching the script": the page is served from
  `http://tauri.localhost` and `/service-worker.js` cannot be fetched there. It
  is one unhandled rejection in logcat and costs nothing — the shell already
  ships its assets and has no use for a precache — so `kit.serviceWorker` is
  left alone rather than growing a host-shaped exception.

**What a distributed build would still need**, beyond everything the desktop
list below already names: a real minSdk/targetSdk decision, the CSP, and
`devtools` switched back off. The signing keystore has come off that list — the
APK the job hands out is a release build with a stable certificate
([Signing](#signing)) — but it is a sideload key, not a store one.

## What the webview cannot do

Four limits shape everything above. They are facts about WebKitGTK on a page
loaded from the real `tauri://localhost` origin, not about Sapling; the runs
behind them are in ffacf14, f78eff6 and 3f41c84.

- **No OPFS and no `SpeechRecognition`**, the two absences the sections above
  are built around: persistence is native because the sqlite-wasm Worker cannot
  boot here, and dictation had no input method at all until the host grew one —
  which is what [Dictation](#dictation) is. `getUserMedia` *is* here, so only
  the recognition had to move. `SharedArrayBuffer` is absent too, which is half
  of why the browser's sherpa TTS wasm has no path here.

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

The voice adds exactly one: `alsa-lib`, which rodio's cpal backend runs
pkg-config for at build time. It is the easy kind — it fails loudly at build
time, and at *runtime* on NixOS nothing further is needed, because the ALSA
default device reaches PipeWire through its ALSA plugin.

It used to add two more, and both came off when the voice moved to k2-fsa's own
crate: `rustPlatform.bindgenHook`, for a bindings crate that no longer runs
bindgen, and `stdenv.cc.cc.lib` on `LD_LIBRARY_PATH`, which was the third
runtime-only trap of exactly the shape of the other two — no build error, and
every desktop binary dying at startup with `libstdc++.so.6: cannot open shared
object file`, because the prebuilt sherpa `.so` files were linked against an
ordinary distribution's libstdc++ and a shared library's own dependencies are
not resolved through the executable's `DT_RUNPATH`. Static linking made the
question go away.

## What a shipped version would still need

Not done, and each is real work: bundling (icons, `.deb`/`.AppImage`/`.dmg`,
signing), a CSP, SPA fallback for deep routes,
a native menu and window-state persistence, auto-update, and a decision about
whether the desktop build syncs at all — it uses the same `VITE_SYNC_URL` the
web build does, and nothing about that was exercised. A CSP here would have to
allow framing the embed host as well as the two YouTube origins, since a shipped
desktop build reaches YouTube only through that frame.

For the voice specifically: a `cancellable: true` for the `tts-model` task (the
download does not watch for an abort, so the tray still says "Stop watching"),
and macOS/Windows, where none of the linking above has been tried. Shipping
sherpa-onnx has come off this list on desktop targets — it is linked statically
into the binary — but `cargo build` still needs the network once per checkout
to fetch the prebuilt archive into `target/sherpa-onnx-prebuilt/`, and on
Android the two `.so` files are packaged rather than linked in.
