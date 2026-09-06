---
paths:
  - 'crates/sapling-desktop/**'
  - 'src/lib/db/tauri.ts'
  - 'src/lib/tts/native.ts'
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
  second one.** The test is whether the thing is a platform primitive with no
  domain knowledge in it: persistence is a file, TTS is text in and a WAV out,
  playback is a WAV in and a sound out. None of them may grow an opinion. So
  the voice lives here (`src/tts/`, feature `tts`, on by default) because
  WebKitGTK cannot run the browser's engine at all, while `src/lib/tts/` keeps
  every decision — which language routes to Kokoro, which speaker, when to fall
  back to the browser voice, what to cache — and is the same code the web build
  runs. The line that does not move: a host still contains no merge rule and no
  SQL against the read tables.

- **Speech does not touch the webview's audio stack, and that was measured, not
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
  **The voice adds exactly five more** — `tts_status`, `tts_download`,
  `tts_synthesize`, `tts_play`, `tts_stop` — and they are not part of that
  protocol and never touch it. A clip crosses as bytes in both directions and
  never as JSON: `tts_synthesize` answers a `tauri::ipc::Response`, and
  `tts_play` takes a raw body (`tauri::ipc::Request` with `InvokeBody::Raw`,
  invoked from JavaScript with a `Uint8Array`), because ~150 KB of PCM as an
  array of decimal digits is megabytes of text to serialize and to parse.
  `tts_play` takes bytes rather than text because the clip caches are the
  window's; if they ever move to the host, `tts_speak(text, sid, speed)`
  replaces `tts_play(bytes)` and nothing in `play.rs` changes shape.

- **Every command that waits for anything is `async` and hands its work to
  `spawn_blocking`.** A synchronous Tauri command runs on the main thread — the
  GTK loop that composites the webview — so a second of ONNX inference there is
  a frozen window, and so is a commit's fsync: `dispatch` blocks until the core
  thread has answered, and `applyResult` makes three or more such calls on every
  Check. That is `dispatch`, `commit_all`, `tts_download`, `tts_synthesize` and
  `tts_play`, which waits for the whole clip. `derived_schema_version` stays
  synchronous because it reads a constant, and `tts_stop` because it posts one
  message and waits for nothing — and it is on the path to every new phrase,
  where a round trip through the pool would be pure latency. The
  database is therefore managed as `Arc<Database>` — `spawn_blocking` needs
  something owned and `'static`, exactly as `TtsHandle` does. **The price is
  ordering**, and it is paid on the JavaScript side: see the transport bullet.

- **`tts::kokoro` is the only `unsafe` in the crate**, which is why the root
  says `deny(unsafe_code)` rather than `forbid`. It exists because
  `sherpa-rs`'s safe wrapper frees the rule-FST path string before sherpa-onnx
  reads it; the module's own header carries the detail. Nothing else may opt
  out, and the dependency is `sherpa-rs-sys` with `download-binaries` — the
  bindings and the prebuilt libraries must come from the same sherpa-onnx tag
  or the TTS config structs disagree about their own layout.

- **`src/lib/platform.ts` is where "am I in Tauri?" is asked**, once, by
  `db/backend.ts`, `tts/tts.ts` and `media/youtube-host.ts`. Everything
  host-specific stays behind a dynamic import gated on it (`db/tauri.ts`,
  `tts/native.ts`), so a browser fetches neither those modules nor
  `@tauri-apps/api`. `media/youtube-host.ts` is the documented exception and
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
  been spoken to has nothing to stop. `tts.ts` holds the fallback decision, not
  this module: **no output device** is latched for the session and warned about
  once (the element path still works there, slowly, which beats silence), while
  a clip the host merely refuses falls back alone. The `TtsEngine` preference
  values do
  **not** change — `'kokoro'` has always named the good downloaded neural voice,
  and it now means Kokoro from whichever host provides it, with identical
  speaker ids because it is identical model. Two differences are deliberate and
  both are documented in `docs/desktop.md`: `init` downloads the model but does
  not load the engine (no fourth command; the load lands in the `warmSpeech`
  the session screen already fires), and the **Cache Storage clip tier is
  skipped** here because native synthesis runs at several times real time.

- **The crate is a workspace member but not a *default* member.** It links
  WebKitGTK, which only `nix develop .#desktop` provides, and `pnpm core:check`
  / `pnpm core:test` are a bare `cargo clippy`/`cargo test` in the *default*
  shell. Reach it with `-p sapling-desktop` (`pnpm desktop:check` does), and
  keep it rustfmt-clean — `cargo fmt --check` walks every member, default or
  not. New source files must be `git add`ed before nix can see them.

- **The voice's two tests are skip-if-absent, and that is the contract.**
  `tests/voice.rs` synthesizes Mandarin, English and a mixed sentence against
  the *real* 365 MB model and asserts finite, audible samples of a plausible
  length; with no model installed it prints why and passes, because a checkout
  without one is normal and `pnpm desktop:check` must be green in it. The
  `#[ignore]`d `installs_the_model` is how a machine gets one, into the same
  directory the app uses. `tests/playback.rs` is the same shape one layer down:
  it opens the *real* default device and plays generated tones, asserting that a
  100 ms clip returns in roughly 100 ms and that a stop and a second clip both
  cut a long one short — and it skips itself with a printed reason on a machine
  with no output device, because a headless runner is a normal place to run the
  check. Neither may become a mock: what is worth testing is that sherpa-onnx,
  this config and that archive make sound, and that the sound comes out.
