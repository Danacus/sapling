---
paths:
  - 'crates/sapling-desktop/**'
  - 'src/lib/db/tauri.ts'
  - 'src/lib/tts/native.ts'
  - 'src/lib/platform.ts'
---

# The desktop shell

Runbook: `docs/desktop.md`. **Status: a spike.** It runs, it persists, and it is
not shipped — nothing in the web build, the gates or CI depends on it.

- **`crates/sapling-desktop` is a host, and that is all it is.** It owns a file
  (`sapling.db` in Tauri's app-data directory), a device id, the system clock
  and the system time zone, and it hands all four to `sapling-core` through the
  `Sql`/`LocalDay` seams `core.md` describes. It contains **no merge rule, no
  read, and no SQL against the read tables** — the one statement it issues is
  `PRAGMA journal_mode = WAL`, which is a property of the file and not of the
  data. A behaviour that differs between the browser and the desktop is a bug
  in one of the two hosts; there is only one implementation of the rules.

- **A host may lend a *capability* the webview cannot run, and speech is the
  second one.** The test is whether the thing is a platform primitive with no
  domain knowledge in it: persistence is a file, TTS is text in and a WAV out.
  Neither may grow an opinion. So the voice lives here (`src/tts/`, feature
  `tts`, on by default) because WebKitGTK cannot run the browser's engine at
  all, while `src/lib/tts/` keeps every decision — which language routes to
  Kokoro, which speaker, when to fall back to the browser voice, what to cache
  — and is the same code the web build runs. The line that does not move: a
  host still contains no merge rule and no SQL against the read tables.

- **The persistence commands are exactly `WasmCore`'s surface**, name for name:
  `dispatch(method, args) -> Result<Option<String>, String>`, `commit_all`,
  `derived_schema_version`. No fourth one, and no new `Backend` method that the
  browser does not also have — the protocol is `src/lib/db/protocol.ts` and
  `dispatch.rs`, and adding to it is still the three edits `core.md` names.
  **The voice adds exactly three more** — `tts_status`, `tts_download`,
  `tts_synthesize` — and they are not part of that protocol and never touch it.
  `tts_synthesize` answers a `tauri::ipc::Response` carrying a whole WAV file,
  because a `Vec<u8>` would cross as a JSON array of numbers. Both long
  commands are `async` and hand their work to `spawn_blocking`: a synchronous
  Tauri command runs on the main thread, and a second of ONNX inference there
  is a frozen window.

- **`tts::kokoro` is the only `unsafe` in the crate**, which is why the root
  says `deny(unsafe_code)` rather than `forbid`. It exists because
  `sherpa-rs`'s safe wrapper frees the rule-FST path string before sherpa-onnx
  reads it; the module's own header carries the detail. Nothing else may opt
  out, and the dependency is `sherpa-rs-sys` with `download-binaries` — the
  bindings and the prebuilt libraries must come from the same sherpa-onnx tag
  or the TTS config structs disagree about their own layout.

- **`src/lib/platform.ts` is where "am I in Tauri?" is asked**, once, by both
  `db/backend.ts` and `tts/tts.ts`. Everything host-specific stays behind a
  dynamic import gated on it (`db/tauri.ts`, `tts/native.ts`), so a browser
  fetches neither those modules nor `@tauri-apps/api`.

- **One thread owns the core, and this is not a style choice.** `Core` is
  `!Send` — its `Sql`, clock, ids and calendar are plain boxed trait objects,
  and they must stay plain because the wasm host's `JsSql` holds a
  `js_sys::Function`, which can never be `Send`. So `Mutex<Core>` will not
  compile as Tauri managed state. `host.rs` instead spawns one thread that owns
  the core for its whole life and posts closures to it; that serialises calls
  arriving from Tauri's command pool, and dropping `CoreHandle` closes the
  channel and joins, so "the database is closed" is true by the time the drop
  returns.

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
  `@tauri-apps/api`.

- **`src/lib/tts/native.ts` is the same kind of thing for the voice**: three
  `invoke`s and one Tauri event listener behind the shape `sherpa.ts` already
  offered `tts.ts` (`init`, `onProgress`, `synthesize` → a WAV `Blob`), which is
  what makes the router a one-line choice. The `TtsEngine` preference values do
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

- **The voice's own test is skip-if-absent, and that is the contract.**
  `tests/voice.rs` synthesizes Mandarin, English and a mixed sentence against
  the *real* 365 MB model and asserts finite, audible samples of a plausible
  length; with no model installed it prints why and passes, because a checkout
  without one is normal and `pnpm desktop:check` must be green in it. The
  `#[ignore]`d `installs_the_model` is how a machine gets one, into the same
  directory the app uses. Nothing here may become a mock: what is worth testing
  is that sherpa-onnx, this config and that archive actually make sound.
