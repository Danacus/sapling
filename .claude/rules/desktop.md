---
paths:
  - 'crates/sapling-desktop/**'
  - 'src/lib/db/tauri.ts'
  - 'src/lib/tts/native.ts'
  - 'src/lib/asr/native.ts'
  - 'src/lib/platform.ts'
---

# The desktop shell

Runbook: `docs/desktop.md`. **Status: a spike.** It runs, it persists, and it is
not shipped — nothing in the web build or its gates depends on it. CI does run
`pnpm desktop:check` in its own `desktop` job (non-gating for the deploy), so
a protocol change that breaks the host fails the commit rather than waiting for
someone to run the check by hand.

- **`crates/sapling-desktop` is a host, and that is all it is.** It owns a file
  (`sapling.db` in Tauri's app-data directory), a device id, the system clock
  and the system time zone, and it hands all four to `sapling-core` through the
  `Sql`/`LocalDay` seams `core.md` describes. It contains **no merge rule, no
  read, and no SQL against the read tables** — the only statements it issues are
  two pragmas, `journal_mode = WAL` and `synchronous = NORMAL`, which are
  properties of the file and the connection and not of the data. NORMAL is what
  makes WAL worth having: at SQLite's default FULL every commit fsyncs the WAL,
  and one Check writes three or more back to back. Under WAL, NORMAL is still
  durable against an application crash and gives up only the last transaction on
  a power cut. `PRAGMA synchronous = …` answers nothing, so unlike `journal_mode`
  it is read back to know it took. A behaviour that differs between the browser
  and the desktop is a bug in one of the two hosts; there is only one
  implementation of the rules.

- **A host may lend a *capability* the webview cannot run, and speech is the
  second one — in both directions.** The test is whether the thing is a platform
  primitive with no domain knowledge in it: persistence is a file, TTS is text in
  and a WAV out, playback is a WAV in and a sound out, recognition is samples in
  and a sentence out. None of them may grow an opinion. So the voice lives here
  (`src/tts/`) because WebKitGTK cannot run the browser's engine at all, and
  dictation lives here (`src/asr/`) because neither this webview nor Android's
  has a `SpeechRecognition` at all — while `src/lib/tts/` and `src/lib/asr/` keep
  every decision (which language routes to Kokoro, which speaker, which languages
  the recognizer is offered for, when to fall back, what to cache, and the rule
  that a transcript lands in the composer unread) and are the same code the web
  build runs. The line that does not move: a host still contains no merge rule
  and no SQL against the read tables.

- **One feature, `speech`, covers both directions**, on by default. It was `tts`
  until dictation arrived, and it is one feature because synthesis and
  recognition are the same dependency set — sherpa-onnx, plus the download,
  checksum and unpack of a pinned archive — over the same `src/models.rs`;
  splitting it would put `any(feature = …)` on that shared module and make four
  build configurations nobody would check. **`src/models.rs` is that shared
  floor**: one `ModelSpec` per model (`KOKORO`, `SENSE_VOICE`) pinning URL, exact
  byte size, sha256 and the files that must exist, plus the one
  download-verify-stage-rename install and the ONNX thread count both engines
  want. A `ModelSpec` is the *only* place a model is described, so swapping one
  is a constant change; the two progress keys are derived from `dir`
  (`<dir>.tar.bz2` and `<dir> (unpacking)`), which is what
  `$lib/tasks/kinds/model-download` sums, so renaming a spec renames what a
  progress bar keys on.

- **Speech does not touch *WebKitGTK's* audio stack, and that was measured, not
  assumed.** On WebKitGTK 2.52.6 / GStreamer 1.28.5 an `<audio>` element over a
  blob plays correctly but builds a fresh GStreamer pipeline per clip: the first
  sample lands about a second late and the window stalls while it is built, on
  every spoken word. Web Audio, the obvious way to keep one pipeline for the
  session, is worse than slow — a bare oscillator alternates between clean and
  noise across runs and an `AudioBufferSourceNode` plays silence (commit
  f78eff6 reverted that attempt and its message carries the detail). So the clip
  goes back across the IPC and rodio plays it: `src/tts/play.rs`, `tts_play` and
  `tts_stop`. **Only speech moved.** The reader's `<video>` and the YouTube
  frame still go through GStreamer, which is why the shell still carries the
  plugins, and `src/lib/tts/`'s element path is still the code the web build
  runs *and* this host's fallback.

- **That is a fact about one webview, so it is the one thing the Android build
  does differently.** Chromium plays a blob without any of that, so on Android
  `tts::play`, `rodio`, `tts_play` and `tts_stop` do not exist and the clip
  stays in the window. **The window is told rather than left to infer it**:
  `TtsStatus` carries `playback` (`tts::HOST_PLAYS_AUDIO`, which is `cfg!(desktop)`),
  `tts.ts` reads it off the `tts_status` probe it already makes, and a host that
  answers `false` never attempts `tts_play` — no per-clip failure, no warning,
  no "no output device" latch. `inTauri()` stays the only platform test on the
  web side; everything else about the host is asked of the host.

- **One output stream for the process, owned by one thread**, for the reason
  `host.rs` gives about the core: rodio's `MixerDeviceSink` holds a
  `cpal::Stream`, which is `!Send` on ALSA, so it cannot be Tauri managed state
  and gets a thread and a channel instead. Opening a device per clip would put
  back the start latency this whole slice exists to remove, so it is opened
  once — on the *first* clip, not at boot, and the outcome is memoised either
  way, so a learner who never taps 🔊 never holds an audio device open. The
  waiting is the caller's, never the thread's: `tts_play` resolves when the clip
  ends because that is the promise `speak()` has always made, and the owning
  thread signals that by *dropping* the caller's channel — a thread that blocked
  on the clip could not answer `tts_stop`. A new clip cuts off the one playing,
  which is what makes a second tap on 🔊 interrupt the first word. `alsa-lib` is
  in the `desktop` devShell for cpal's build; at runtime the ALSA default device
  reaches PipeWire through its own plugin and nothing further is needed.

- **A database that will not open is a screen, not a crash.** `setup` never
  returns `Err` for it: `host::Database` is the managed state, holding either
  the `CoreHandle` or the reason there is none, and every persistence command
  answers that reason as its `Err`. There is no boot message on this host (the
  browser's `ready`/`bootError` exists because a Worker has no other way to
  speak first), so `openTauriBackend` makes one probe read (`poolSize`) before
  it resolves, and its rejection is what `+layout.svelte` shows. The message
  is prefixed `The database could not be opened:` and is shown verbatim.

- **The persistence commands are exactly `WasmCore`'s surface**, name for name:
  `dispatch(method, args) -> Result<Option<String>, String>`, `commit_all`,
  `derived_schema_version`. No fourth one, and no new `Backend` method that the
  browser does not also have — the protocol is `src/lib/db/protocol.ts` and
  `dispatch.rs`, and adding to it is still the three edits `core.md` names.
  **Speech adds exactly eight more** — `tts_status`, `tts_download`,
  `tts_synthesize`, `asr_status`, `asr_download`, `asr_transcribe` on every
  target, and `tts_play`, `tts_stop` on desktop targets only — and they are not
  part of that protocol and never touch it. Audio crosses as bytes in every
  direction and never as JSON: `tts_synthesize` answers a
  `tauri::ipc::Response`, and `tts_play` and `asr_transcribe` take a raw body
  (`tauri::ipc::Request` with `InvokeBody::Raw`, invoked from JavaScript with a
  `Uint8Array`), because ~150 KB of a clip or ~320 KB of an utterance as an
  array of decimal digits is megabytes of text to serialize and to parse.
  `tts_play` takes bytes rather than text because the clip caches are the
  window's; if they ever move to the host, `tts_speak(text, sid, speed)`
  replaces `tts_play(bytes)` and nothing in `play.rs` changes shape.
  `asr_transcribe` takes no language, because the model identifies its own and
  the *routing* — which languages reach this host at all — is `asr_status`'s
  `languages`, answered one screen up.

- **The microphone is not in this crate, and must not arrive in it.** Capture is
  the window's on both hosts: `getUserMedia` works in both webviews, so
  `src/lib/asr/native.ts` records 16 kHz mono PCM with an `AudioWorklet` and
  hands the host samples that already exist. The desktop's reason for taking
  *playback* over is a measured WebKitGTK stall on the way out and has no
  counterpart on the way in, and `rodio`'s `recording` feature stays off. What
  that buys is one code path, permissions that are the browser's, and a host
  that cannot listen to anything nobody pressed a button for.

- **Every command that waits for anything is `async` and hands its work to
  `spawn_blocking`.** A synchronous Tauri command runs on the main thread — the
  GTK loop that composites the webview — so a second of ONNX inference there is
  a frozen window, and so is a commit's fsync: `dispatch` blocks until the core
  thread has answered, and `applyResult` makes three or more such calls on every
  Check. That is every command but `derived_schema_version` and `tts_stop`,
  including the two `_status` ones, which wait for no lock at all but do read the
  disk, from a screen a learner opens mid-phrase. **Neither `TtsHandle::status`
  nor `AsrHandle::status` may take its engine mutex**: that mutex is held across
  a model load plus a second of inference, and Settings parking behind it is the
  bug this rule forbids. `loaded` is an `AtomicBool` beside the engine, and
  "installed" and the model's size on disk are measured once and latched — an
  installed model does not uninstall itself while the process runs, and the size
  is a walk of the whole tree. Not installed re-probes every call. Neither reader
  takes the install lock and neither needs to: **an install is staged and renamed
  into place** (`models.rs`, for both models), so the live model path is always
  either absent or a whole model. `unpack` extracts into a `.partial` sibling,
  one `fs::rename` publishes it, and the next install sweeps what a crash left.
  That rename is what makes `load` safe to run mid-download — sherpa-onnx handed
  a half-written `espeak-ng-data` calls `exit(-1)` and takes the process with it
  — and `load` must stay lock-free, because taking `installing` would park every
  phrase behind a 365 MB download.
  `derived_schema_version` stays
  synchronous because it reads a constant, and `tts_stop` because it posts one
  message and waits for nothing — and it is on the path to every new phrase,
  where a round trip through the pool would be pure latency. The
  database is therefore managed as `Arc<Database>` — `spawn_blocking` needs
  something owned and `'static`, exactly as `TtsHandle` does. **The price is
  ordering**, and it is paid on the JavaScript side: see the transport bullet.

- **`src/lib/asr/native.ts` is `tts/native.ts`'s sibling plus the one thing the
  voice does not need — the microphone.** Three `invoke`s and one event
  listener, and a `dictateNatively` that has to turn an asynchronous capture into
  `listen`'s synchronous contract: the synchronous half of "can this start" is
  whether the window has `getUserMedia` and an `AudioContext` at all (that is the
  only `undefined`), and everything after — a refused permission, a worklet that
  would not load, a rejected `asr_transcribe` — is a session that ends, **exactly
  once**, with a message only where the learner can act. `stop()` and `abort()`
  arriving before the permission prompt resolves are the paths that make that
  hard and are the ones the tests are mostly about. The router
  (`src/lib/asr/index.ts`) holds every decision, not this module, exactly as
  `tts.ts` does for the voice.

- **The crate `forbid`s `unsafe_code`, and the voice is k2-fsa's own crate.**
  `tts::kokoro` used to be the one exception — hand-rolled FFI, because the
  third-party `sherpa-rs` wrapper freed the rule-FST path string before
  sherpa-onnx read it and the FSTs are not optional here. The dependency is
  `sherpa-onnx` now (the safe wrapper published from the sherpa-onnx repository,
  over its own `sherpa-onnx-sys`), whose `OfflineTts::create` keeps every
  `CString` alive across the C call, so the FFI is gone and so is the `unsafe`.
  Three things follow and each has cost time before: the version is pinned `=`
  because **the version is the sherpa-onnx tag** — the build script downloads
  the release archive of that exact name, so bindings and library can never
  disagree about a struct's layout, and a `^` requirement would let a lockfile
  update move the tag; linking is **static** on desktop targets, so there is no
  `.so` to find, no `$ORIGIN` rpath in `build.rs` and no libstdc++ on
  `LD_LIBRARY_PATH`; and the bindings are **pregenerated**, so nothing here runs
  bindgen and no shell or CI job needs a libclang.

- **`src/lib/platform.ts` is where "am I in Tauri?" is asked** — one test, and
  each area asks it at its own seam rather than once per process: the
  persistence transport (`db/backend.ts`), the TTS provider (`tts/tts.ts`, which
  asks again wherever the host changes the answer — whether stored clips are
  worth keeping, what a first download costs, where a clip plays), the dictation
  router (`asr/index.ts`, once, to decide whether there is a host to probe at
  all), the media player host (`media/youtube-host.ts`), and the settings
  screen's native-voice row. Nowhere else, and never a second implementation of
  the test. Everything host-specific stays behind a dynamic import gated on it
  (`db/tauri.ts`, `tts/native.ts`, `asr/native.ts`), so a browser fetches
  neither those modules nor `@tauri-apps/api`. `media/youtube-host.ts` is the documented exception and
  imports statically: it pulls in no host SDK — a few hundred bytes of DOM and a
  message listener — and a dynamic import would make the player factory `async`,
  which is exactly what `youtube.ts` refuses to be, because the reader builds its
  player synchronously inside an effect.

- **This host cannot play YouTube by itself, and the workaround is a hosted
  page.** The IFrame API will not configure a player for a document with no
  valid HTTP(S) referer, and a browser sends none for a custom scheme — so every
  embed served from `tauri://localhost` fails with error 153 and a frame that
  never fills (upstream: tauri-apps/tauri#14422). No configuration fixes it:
  `useHttpsScheme` is Windows and Android only, and `tauri-plugin-localhost`
  would serve the app over real HTTP at the cost of the IPC every persistence
  command rides on. So the *one document* that talks to YouTube is deployed to a
  real HTTPS origin (`embed/`, `deploy.md`) and framed, with `Player` bridged
  over `postMessage` — `media.md` is the contract and `src/lib/media/` holds all
  of it. **The crate is untouched by this**: it is a web-layer workaround for a
  webview limitation, not a capability a host lends, and nothing about it may
  grow into the Rust side. The build-time `VITE_YOUTUBE_EMBED_URL` is what points
  the app at the page; unset, a YouTube text says so in the video's place and the
  text is still readable, and `pnpm desktop:dev` takes the same path as a release
  build on purpose — the path that ships is the path that gets tested.

- **One thread owns the core, and this is not a style choice.** `Core` is
  `!Send` — its `Sql`, clock, ids and calendar are plain boxed trait objects,
  and they must stay plain because the wasm host's `JsSql` holds a
  `js_sys::Function`, which can never be `Send`. So `Mutex<Core>` will not
  compile as Tauri managed state. `host.rs` instead spawns one thread that owns
  the core for its whole life and posts closures to it; that serialises calls
  arriving from Tauri's command pool, and dropping `CoreHandle` closes the
  channel and joins, so "the database is closed" is true by the time the drop
  returns. It serialises them; it does not *order* them — with the commands
  `async`, several pool threads can be inside `CoreHandle::run` at once and
  whichever reaches the channel first is served first.

- **The device id is a file, `device-id`, beside the database.** It is half of a
  review's identity (`reviews` is keyed `(itemId, at, device)`), so it must
  survive every restart *and* `resetData`, which empties the whole database,
  `meta` included. It is minted once with UUID v4 and never rewritten. There is
  no `init` handshake here — that exists because the browser's Worker cannot
  read `localStorage`, and this host has no such problem.

- **`src/lib/db/tauri.ts` is a transport, nothing more.** `client.ts` owns the
  proxy (`backendOver`, one `Transport` function) and `toPlain`; this module
  only carries a call and parses the answer, exactly as `host.ts`'s `directOf`
  does — `null` back from the command is `undefined`, because JSON cannot say
  it. `backend.ts` decides which transport by `inTauri()`, and imports this
  module only when that is true, so a browser loads neither it nor
  `@tauri-apps/api`. **It carries one thing the Worker transport gets for
  free: the order.** A Worker's message queue is first-in-first-out, so two
  calls issued without awaiting run in the order they were made; async commands
  on a thread pool promise nothing of the sort, and a caller that fires a write
  and then reads could see the state before it. So every `invoke` is chained
  behind the previous one — behind its *settling*, so a rejected call does not
  wedge the queue — which restores exactly the Worker's guarantee and costs no
  throughput, since the core is one thread either way. The fix belongs here and
  not in the host, which has no way to know what order the window meant.

- **`src/lib/tts/native.ts` is the same kind of thing for the voice**: five
  `invoke`s and one Tauri event listener behind the shape `sherpa.ts` already
  offered `tts.ts` (`init`, `onProgress`, `synthesize` → a WAV `Blob`), which is
  what makes the router a one-line choice, plus the two `sherpa.ts` has no
  answer for (`playOnHost`, `stopOnHost`). Those two are ordered against each
  other and it matters: a `tts_stop` that overtakes the `tts_play` it was meant
  to precede silences the *new* word, so `native.ts` keeps `invoke` as a plain
  value once the dynamic import has landed and `stopOnHost` sends without an
  `await` — and is correctly a no-op before then, since a host that has never
  been spoken to has nothing to stop. `tts.ts` holds every decision, not this
  module: a host that answers `playback: false` is never asked to play at all,
  and on one that does, **no output device** is latched for the session and
  warned about once (the element path still works there, slowly, which beats
  silence), while a clip the host merely refuses falls back alone. The
  `TtsEngine` preference
  values do
  **not** change — `'kokoro'` has always named the good downloaded neural voice,
  and it now means Kokoro from whichever host provides it, with identical
  speaker ids because it is identical model. Two differences are deliberate and
  both are documented in `docs/desktop.md`: `init` downloads the model but does
  not load the engine (no fourth command; the load lands in the `warmSpeech`
  the session screen already fires), and the **Cache Storage clip tier is
  skipped** here because native synthesis runs at several times real time.

- **The crate also builds for Android, in CI and nowhere else, and there it is
  this host minus the *player*.** `docs/desktop.md` has the job; the contract is
  that Android is not a second host. Persistence, the device id, the clock, the
  calendar **and all of speech** are the same code over the same app-data
  directory — the same sherpa-onnx, the same 365 MB Kokoro archive, the same
  163 MB SenseVoice archive, the same six status/download/work commands. Only
  `rodio` is target-scoped
  (`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`),
  and only `tts::play`, `tts_play` and `tts_stop` are gated
  `all(feature = "speech", desktop)` — `desktop` being Tauri's own cfg alias,
  emitted by `tauri_build::build()`. **Widening one of those two gates to
  `feature = "speech"` alone is a bug** that only Android's compiler sees; the
  reverse — narrowing a synthesis or recognition gate back to `desktop` — is a
  bug nobody's compiler sees, and costs the phone its voice or its ears.
  `cargo tree -p sapling-desktop --target aarch64-linux-android` is how the
  dependency half is checked: no `rodio`, no `cpal`, everything else identical.
- **Android's microphone permission is a manifest edit and nothing more.** wry's
  own `RustWebChromeClient.onPermissionRequest` already answers the WebView's
  `AUDIO_CAPTURE` request by launching a runtime request for `RECORD_AUDIO` *and*
  `MODIFY_AUDIO_SETTINGS` and granting the page only if **every** one comes back
  granted, and wry installs that client itself — so no `MainActivity` override is
  needed. But an undeclared permission is denied with no prompt, and that "every"
  means the normal-protection `MODIFY_AUDIO_SETTINGS` has to be declared beside
  the dangerous `RECORD_AUDIO` or the whole grant fails silently. Both are in the
  committed `AndroidManifest.xml`, with a comment, because that is a file a
  regeneration overwrites.
- **The two sherpa `.so` files reach the APK from `build.rs`, and nothing else
  puts them there.** `sherpa-onnx-sys` links shared on Android and Tauri's
  Gradle plugin packages exactly one library, the crate's own — so `build.rs`
  copies `libsherpa-onnx-c-api.so` and `libonnxruntime.so` out of
  `<target>/sherpa-onnx-prebuilt/…/jniLibs/<abi>/` into
  `gen/android/app/src/main/jniLibs/<abi>/` (gitignored by the generated
  project) whenever `CARGO_CFG_TARGET_OS` is `android`. It must read
  `CARGO_CFG_TARGET_OS` and never `cfg!(target_os)`, which on a build script is
  the *host's*. The ordering is safe because `sherpa-onnx-sys` declares
  `links = "sherpa-onnx"`, which is what makes cargo run its build script first;
  without that key the two would race on a cold cache. No third library is
  needed — `readelf -d` on both lists only `libandroid`, `liblog`, `libm`,
  `libdl`, `libc` and `libonnxruntime`, so there is no `libc++_shared.so` to
  ship, and Android's loader resolves `DT_NEEDED` against the APK's own lib
  directory, so there is no rpath either. **What is trusted is the APK, not the
  build script**: whether cargo reran it is cargo's business, so the workflow
  greps the finished APK for all three libraries and fails if one is missing.
- Two consequences of Android reach outside the crate:
  `[lib] crate-type` carries `cdylib` because the app on that platform is
  `libsapling_desktop.so` and there is no executable (`main.rs` is empty there,
  and `run()` carries `#[cfg_attr(mobile, tauri::mobile_entry_point)]`); and
  `src/lib/tts/tts.ts` asks the host what it lends instead of assuming Tauri
  means everything — see `content.md`.

- **The APK is a *release* build signed with a key that is not in this tree, and
  a missing key may not fail it.** A debug APK is signed with whatever throwaway
  keystore Gradle minted on that runner, so every download demands an uninstall
  before it will install; one stable certificate is what makes `adb install -r`
  work and what keeps a phone's data across builds. The key is four
  `ANDROID_*` repository secrets, written back into
  `gen/android/keystore.properties` and a `.jks` beside it — both gitignored, by
  the generated project's own `.gitignore` — and `app/build.gradle.kts` reads
  them into `signingConfigs.release`. **With no properties file it falls back to
  the debug key and logs why**, because a fork and every pull request from one
  have no secrets and a release build is now the only build there is; unsigned
  would be the wrong fallback, since AGP renames an unsigned release APK and the
  job names one exact file. `apksigner verify --print-certs` at the end of the
  job is the gate: what is uploaded is signed, and the log says by whom.
  `tauri`'s `devtools` feature is on for the same reason the crate exists — a
  release webview is otherwise not inspectable at all — and comes off when the
  app is distributed.

- **`gen/android` is committed, and the CI job may never regenerate it.** It
  started out generated per run; it is a checked-in tree now because two things
  about the app exist *only* as edits to it, and `tauri android init` writes
  Tauri's defaults back over both. Those two are the launcher icons
  (`app/src/main/res/mipmap-*`, made from `static/icons/icon-512.png` by
  `tauri icon`) and the **window insets in `MainActivity.kt`**: the template
  calls `enableEdgeToEdge()` and the project targets SDK 36, so without them the
  status bar sits on top of the app. The theme opt-out
  (`android:windowOptOutEdgeToEdgeEnforcement`) is not an alternative — it
  cannot undo an explicit `enableEdgeToEdge()`, and it is deprecated and ignored
  for an app targeting 36 on Android 16 — and neither is
  `env(safe-area-inset-*)`, which is a bet on a WebView behaviour nothing here
  can check. So the insets are applied where they are a fact: as padding on the
  activity's content view, the `FrameLayout` wry calls `setContentView(webView)`
  on, which *sizes* the WebView to the safe area. The `.gitignore` that keeps
  the tree honest is the generated project's own, and it already covers
  everything `tauri android build` rewrites per run (`app/tauri.build.gradle.kts`,
  `app/tauri.properties`, `app/proguard-tauri.pro`, the assets copy of
  `tauri.conf.json`, `jniLibs/*.so`, the `generated/` sources, `build/`) plus the
  signing material the job writes (`keystore.properties`, `*.jks`), so a CI build
  leaves the tree clean. The root `.gitignore` keeps only `gen/schemas/`, which
  `tauri-build` writes on every desktop build.

- **The crate is a workspace member but not a *default* member.** It links
  WebKitGTK, which only `nix develop .#desktop` provides, and `pnpm core:check`
  / `pnpm core:test` are a bare `cargo clippy`/`cargo test` in the *default*
  shell. Reach it with `-p sapling-desktop` (`pnpm desktop:check` does), and
  keep it rustfmt-clean — `cargo fmt --check` walks every member, default or
  not. New source files must be `git add`ed before nix can see them.

- **The speech tests are skip-if-absent, and that is the contract.**
  `tests/voice.rs` synthesizes Mandarin, English and a mixed sentence against
  the *real* 365 MB model and asserts finite, audible samples of a plausible
  length; `tests/dictation.rs` transcribes the `test_wavs/` that ship inside the
  *real* 163 MB recognition model and asserts what the words were, in Mandarin,
  English and Cantonese (the last by its particles — 唔, 嘅, 呢 — because what is
  worth checking is that the model switched language rather than transcribing bad
  Mandarin). With no model installed each prints why and passes, because a
  checkout without one is normal and `pnpm desktop:check` must be green in it.
  The `#[ignore]`d `installs_the_model` in each is how a machine gets one, into
  the same directory the app uses; `tests/common/mod.rs` is the app-data path
  both work out by hand. `tests/playback.rs` is the same shape one layer down,
  and is `#![cfg(desktop)]` in its entirety because the module it covers is:
  it opens the *real* default device and plays **silence** through it, asserting
  that a 100 ms clip returns in roughly 100 ms and that a stop and a second clip
  both cut a long one short — and it skips itself with a printed reason on a
  machine with no output device, because a headless runner is a normal place to
  run the check. Silence rather than a tone because zero samples are still
  samples: the stream and every wall-clock number are real, and running the
  check is not an event in the room. What silence cannot show is that the sound
  comes *out*, so one clip is audible and `#[ignore]`d for it, exactly like
  `installs_the_model`. **None of the three may become a mock**: what is worth
  testing is that sherpa-onnx, this config and that archive make sound, that the
  sound comes out, and that real speech comes back as the right words.
