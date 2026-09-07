//! Sapling on the desktop: a Tauri v2 shell around `sapling-core`.
//!
//! The app is the same SvelteKit SPA the web ships, loaded into a webview; the
//! only thing that changes is where persistence lives. In the browser the core
//! is compiled to wasm and runs inside a Worker over sqlite-wasm in OPFS
//! (`src/lib/db/sqlite.worker.ts`); here it runs natively over a SQLite *file*
//! in the app-data directory, and the window reaches it through the same
//! domain-level protocol — `dispatch(method, argsJson)` in, JSON out.
//!
//! **This crate is a host and nothing else.** The persistence commands below
//! are the exact surface `WasmCore` exposes to the Worker, name for name, so
//! neither side can grow a method the other lacks; every merge rule, every read
//! and every line of SQL against the read tables stays in `sapling-core`.
//!
//! Every command that waits for anything is `async` and hands its work to
//! `spawn_blocking`, because a synchronous Tauri command runs on the main
//! thread — the GTK loop that composites the webview — and anything it waits
//! for is a frozen window. That is the two persistence commands as much as the
//! long speech ones — and `tts_status`/`asr_status`, which are short but read
//! the disk and are asked for *while* one of the long ones is running:
//! `dispatch` blocks until the core thread has committed, and one Check makes
//! three or more of those calls. The price is that the pool
//! decides which of two overlapping calls reaches the core first, so the window
//! keeps its own order (`src/lib/db/tauri.ts`); see `host.rs`'s header.
//!
//! Persistence is not the only thing a host can lend, though. **Speech is the
//! second, and it goes both ways** (feature `speech`, on by default). The `tts`
//! module is Kokoro synthesis, which the browser runs as sherpa-onnx compiled
//! to WASM and this host runs natively, because WebKitGTK cannot run that WASM
//! path at all — and, for a separate reason measured separately, the *playing*
//! of the clip too, because this webview's audio stack starts a second late per
//! clip and its Web Audio output does not work at all (`tts/play.rs`). The
//! `asr` module is SenseVoice dictation, which the browser has only as the Web
//! Speech API — absent in this webview, absent in Firefox, and a round trip to
//! a vendor where it exists. Both are still *host* capabilities — text in, a
//! WAV file out; a WAV file in, a sound out; samples in, a sentence out — with
//! no domain knowledge whatsoever, and `src/lib/tts/native.ts` and
//! `src/lib/asr/native.ts` are the other ends.
//!
//! One feature covers both because they are one dependency set (sherpa-onnx and
//! the model download) over one shared `models` module; the only thing either
//! has to itself is the desktop's player.
//!
//! **The third capability is a video's captions** (`captions`, desktop targets
//! only), and it is the smallest: yt-dlp is run, a `json3` track comes back as
//! text, and the window parses it with the subtitle parser it already has. A
//! browser page cannot obtain a caption track at all — no CORS on YouTube's
//! timedtext endpoints, no track list in the IFrame API — so this closes the
//! one gap in reading mode that had no in-app answer. It brings no dependency
//! (`std::process::Command`) and pins nothing: yt-dlp is found on PATH or it is
//! not, because it ages against YouTube in weeks and a pin here would be a pin
//! on the breakage.
//!
//! ## The same host, minus the *player* and the captions, on Android
//!
//! This crate also builds as an Android app — CI only, and `docs/desktop.md`
//! says what that is for. Persistence is untouched there, because a file in the
//! app-data directory is a file on a phone too, and **so is speech**: the same
//! sherpa-onnx, the same models, the same six commands. Only the *player* is
//! missing, and for the reason it exists at all. `tts::play` is rodio over ALSA
//! because *WebKitGTK* cannot play a clip without a second of latency per word;
//! Android's WebView is Chromium, where an `<audio>` element over a blob is the
//! ordinary path and works. So the clip stays in the window there, `rodio` is
//! declared for desktop targets only (`Cargo.toml`), and exactly two things
//! below read `all(feature = "speech", desktop)` — `tts_play` and `tts_stop` —
//! while everything else about speech reads `feature = "speech"` and builds
//! everywhere. `desktop` is Tauri's own cfg alias for "not Android or iOS",
//! emitted by `tauri_build::build()`.
//!
//! **The captions are missing there for a plainer reason**: there is no yt-dlp
//! on a phone and no PATH to look for one on, so the module and its three
//! commands read `#[cfg(desktop)]` — the same alias, and a target gate rather
//! than a feature, because there is nothing to link and nothing to make
//! optional. A phone still *reads* a text imported this way: the import is an
//! event, so it syncs like every other.
//!
//! **Capture is the window's on both hosts**, which is why there is no
//! microphone anywhere in this crate. `getUserMedia` works in both webviews,
//! and the desktop's reason for taking playback over does not apply to it: the
//! samples arrive here already recorded, as a raw IPC body.
//!
//! Nothing above the seam branches on the platform for it: `tts_status` carries
//! a `playback` flag, `src/lib/tts/tts.ts` reads it off the one probe it
//! already makes, and a host that answers `false` takes the element path
//! without ever calling `tts_play`. A host with no voice commands at all is
//! still handled the way a synthesis that failed is — it degrades; it never
//! blocks — which is what a `--no-default-features` build is.

//! The crate **forbids** `unsafe_code`, and no module may opt out. It used to
//! only deny it, for `tts::kokoro`, which hand-rolled the FFI call into
//! sherpa-onnx because the third-party wrapper of the day freed a config string
//! before the C library read it. That crate is gone: the voice now goes through
//! k2-fsa's own `sherpa-onnx` wrapper, which keeps its `CString`s alive across
//! the call, so there is no FFI here at all any more (`tts/kokoro.rs`).

#![forbid(unsafe_code)]

#[cfg(feature = "speech")]
pub mod asr;
/// Desktop targets only: there is no yt-dlp on a phone, and this is a target
/// gate rather than a feature because there is nothing to link.
#[cfg(desktop)]
pub mod captions;
pub mod host;
#[cfg(feature = "speech")]
pub mod models;
#[cfg(feature = "speech")]
pub mod tts;

use std::sync::Arc;

// `AppHandle` is wanted by the two model downloads (to emit progress) and by
// `captions_fetch` (to find the app-data directory), which are gated on
// different things.
#[cfg(any(feature = "speech", desktop))]
use tauri::AppHandle;
#[cfg(feature = "speech")]
use tauri::Emitter;
use tauri::{Manager, State};

#[cfg(feature = "speech")]
use crate::asr::AsrHandle;
use crate::host::Database;
#[cfg(all(feature = "speech", desktop))]
use crate::tts::play::PlayerHandle;
#[cfg(feature = "speech")]
use crate::tts::TtsHandle;

/// One `Backend` call. The answer is `None` — JavaScript's `undefined` — for a
/// `void` method and for a read of a row that is not there. When the database
/// did not open, every call answers `Err` with the reason, and the first one
/// (`openTauriBackend`'s probe) is what puts it on the boot-error screen.
///
/// `async` on purpose: a synchronous Tauri command runs on the main thread, and
/// this one waits on the core thread's answer — an fsync, or a whole
/// `importData`. A Check writes three or more of these back to back, and on the
/// main thread that is a frozen window.
#[tauri::command]
async fn dispatch(
    db: State<'_, Arc<Database>>,
    method: String,
    args: String,
) -> Result<Option<String>, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.dispatch(method, args))
        .await
        .map_err(|cause| format!("the database call could not run: {cause}"))?
}

/// Appends local facts in one transaction. Here for parity with `WasmCore`;
/// only a test rig seeds a store this way.
///
/// `async` for the same reason as [`dispatch`], and it is the heavier of the
/// two: one transaction over a whole batch of facts.
#[tauri::command]
async fn commit_all(db: State<'_, Arc<Database>>, facts: String) -> Result<(), String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.commit_all(facts))
        .await
        .map_err(|cause| format!("the database call could not run: {cause}"))?
}

/// The read-table shape this build expects — the version `meta` records.
///
/// The one persistence command that stays synchronous: it reads a constant and
/// touches neither the database nor the core thread, so the main thread is the
/// cheapest place to answer it from.
#[tauri::command]
fn derived_schema_version() -> u32 {
    sapling_core::schema::DERIVED_SCHEMA_VERSION
}

// -- Native speech ----------------------------------------------------------
//
// Eight commands, and deliberately no more: is the voice here, put it here, say
// this, make this sound, be quiet — and is dictation here, put it here, what
// did I just say. Six of them are every host's; the two players are the
// desktop's alone, because a phone's WebView already has one. Everything about
// *what* to speak, *which* languages dictate and what a transcript is then for
// — the language mapping, the speaker table, the caches, the fallback to the
// browser engines — stays in `src/lib/tts/` and `src/lib/asr/`, which is the
// same code the web build runs.

/// Event carrying one file's download progress to the window. Its three fields
/// are `TtsProgress`'s, so both `native.ts` modules feed the existing progress
/// listener with it unchanged.
#[cfg(feature = "speech")]
#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    file: String,
    loaded: u64,
    total: u64,
}

/// The channels the progress events travel on — one per model, named once here
/// and once in the matching `native.ts`.
///
/// Two channels rather than one carrying a model name: the two installs are
/// separable at the source, so a shared channel would only mean every listener
/// filtering a stream it never wanted. What names the model is the channel.
#[cfg(feature = "speech")]
const TTS_PROGRESS_EVENT: &str = "tts://model-progress";
#[cfg(feature = "speech")]
const ASR_PROGRESS_EVENT: &str = "asr://model-progress";

/// Emits one install's progress on `channel`. Shared by the two download
/// commands, which differ in nothing else.
#[cfg(feature = "speech")]
fn report(app: &AppHandle, channel: &'static str, file: &str, loaded: u64, total: u64) {
    // A failed emit means the window is gone; the download may as well finish,
    // and the next boot then finds the model already here.
    let _ = app.emit(
        channel,
        DownloadProgress {
            file: file.to_owned(),
            loaded,
            total,
        },
    );
}

/// Whether the voice model is on this machine, and what it costs.
///
/// `async` even though it is the short one: it reads the filesystem, and
/// Settings asks for it while a phrase may be synthesizing. `TtsHandle::status`
/// takes no lock — that is its own contract, and this command would otherwise
/// have parked the main thread behind a whole model load — so the
/// `spawn_blocking` here is only about keeping the `stat`s off the GTK loop.
///
/// A `Result` because Tauri requires one of an `async` command that borrows
/// `State`; the only `Err` it can produce is the blocking task failing to run
/// at all, which `native.ts` sees as a rejected `invoke` like any other.
#[cfg(feature = "speech")]
#[tauri::command]
async fn tts_status(tts: State<'_, Arc<TtsHandle>>) -> Result<tts::TtsStatus, String> {
    let handle = tts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || handle.status())
        .await
        .map_err(|cause| format!("the voice status could not be read: {cause}"))
}

/// Downloads and unpacks the voice model, reporting progress as it goes.
///
/// `async` on purpose: a synchronous Tauri command runs on the main thread, and
/// this one runs for minutes. Idempotent — an installed model returns at once.
#[cfg(feature = "speech")]
#[tauri::command]
async fn tts_download(app: AppHandle, tts: State<'_, Arc<TtsHandle>>) -> Result<(), String> {
    let handle = tts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle.install(&|file: &str, loaded: u64, total: u64| {
            report(&app, TTS_PROGRESS_EVENT, file, loaded, total);
        })
    })
    .await
    .map_err(|cause| format!("the voice-model download could not start: {cause}"))?
}

/// One phrase, as a complete WAV file.
///
/// The answer is `tauri::ipc::Response`, so the bytes cross as a binary payload
/// and become a `Blob` on the other side. A `Vec<u8>` would be serialized as a
/// JSON array of numbers — several megabytes of text per sentence, parsed on
/// the window thread, for audio that is already in the right format.
#[cfg(feature = "speech")]
#[tauri::command]
async fn tts_synthesize(
    tts: State<'_, Arc<TtsHandle>>,
    text: String,
    sid: i32,
    speed: f32,
) -> Result<tauri::ipc::Response, String> {
    let handle = tts.inner().clone();
    let wav = tauri::async_runtime::spawn_blocking(move || handle.synthesize(&text, sid, speed))
        .await
        .map_err(|cause| format!("the voice could not run: {cause}"))??;
    Ok(tauri::ipc::Response::new(wav))
}

// -- Dictation --------------------------------------------------------------

/// Whether the dictation model is on this machine, what it costs, and which
/// languages it covers.
///
/// The last of those is the whole routing contract: `src/lib/asr/` asks this
/// once, memoises it, and offers the microphone only where the answer covers
/// the learner's language. A host built without the feature has no such command
/// and the rejected `invoke` is the answer — the same shape `tts_status` has.
///
/// `async` for the reason `tts_status` is: it reads the filesystem, from a
/// screen a learner may open mid-utterance. `AsrHandle::status` takes no lock.
#[cfg(feature = "speech")]
#[tauri::command]
async fn asr_status(asr: State<'_, Arc<AsrHandle>>) -> Result<asr::AsrStatus, String> {
    let handle = asr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || handle.status())
        .await
        .map_err(|cause| format!("the dictation status could not be read: {cause}"))
}

/// Downloads and unpacks the dictation model, reporting progress as it goes.
///
/// `async` on purpose: a synchronous Tauri command runs on the main thread, and
/// this one runs for minutes. Idempotent — an installed model returns at once.
#[cfg(feature = "speech")]
#[tauri::command]
async fn asr_download(app: AppHandle, asr: State<'_, Arc<AsrHandle>>) -> Result<(), String> {
    let handle = asr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle.install(&|file: &str, loaded: u64, total: u64| {
            report(&app, ASR_PROGRESS_EVENT, file, loaded, total);
        })
    })
    .await
    .map_err(|cause| format!("the dictation-model download could not start: {cause}"))?
}

/// One utterance in, one sentence out.
///
/// The samples arrive as a **raw** IPC body where the IPC can carry one, exactly
/// as `tts_play`'s clip does and for the same reason: ten seconds of 16 kHz
/// 16-bit mono is ~320 KB, and a `Vec<u8>` field crosses as an array of decimal
/// digits — megabytes of text to serialize on the window thread and to parse
/// here. `native.ts` invokes this with a `Uint8Array`, which is what makes the
/// body `InvokeBody::Raw` on the desktop.
///
/// **On Android it is not raw, and cannot be.** Tauri's IPC script never uses
/// the custom protocol there ("Android does not have support to reading the
/// request body"), falls back to `postMessage`, and turns a `Uint8Array`
/// payload into a JSON array of numbers; `tauri::ipc::InvokeBody`'s own docs
/// say `Raw` is never seen on Android. So the JSON form is accepted here too,
/// as `Vec<u8>`: a ten-second utterance is about a megabyte of text, which
/// serde parses in a few milliseconds — a cost worth paying once per sentence,
/// and the only way an utterance reaches this host on a phone. Anything else
/// is a caller bug and says so.
///
/// There is no language argument: the model identifies its own, and which
/// languages reach this host at all is `asr_status`'s `languages` answered one
/// screen up. See `asr/sense_voice.rs`.
///
/// `async` for the reason every waiting command here is — this one loads a
/// 239 MB ONNX session on its first call and decodes on every one.
#[cfg(feature = "speech")]
#[tauri::command]
async fn asr_transcribe(
    asr: State<'_, Arc<AsrHandle>>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let pcm: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(pcm) => pcm.clone(),
        tauri::ipc::InvokeBody::Json(json) => serde_json::from_value(json.clone())
            .map_err(|cause| format!("asr_transcribe takes the audio as bytes: {cause}"))?,
    };
    let handle = asr.inner().clone();
    tauri::async_runtime::spawn_blocking(move || handle.transcribe(&pcm))
        .await
        .map_err(|cause| format!("the recognizer could not run: {cause}"))?
}

/// Plays one clip, resolving when it ends or is stopped.
///
/// The clip arrives as a **raw** IPC body rather than as a JSON field: it is
/// ~150 KB of PCM, and a `Vec<u8>` in either direction crosses as an array of
/// decimal digits. `native.ts` invokes this with a `Uint8Array`, which is what
/// makes the body `InvokeBody::Raw`; anything else is a caller bug and says so.
///
/// `async` for the reason every waiting command here is — a synchronous Tauri
/// command runs on the main GTK loop, and this one waits for the whole clip,
/// which would be a window frozen for exactly as long as the app is speaking.
///
/// Resolving when playback *ends* is the contract `speak()` already had, and it
/// is why there is no event and no second command to poll: the promise is the
/// clip. A clip arriving while another plays cuts that one off, so a second tap
/// on 🔊 interrupts the first word, as it always has.
#[cfg(all(feature = "speech", desktop))]
#[tauri::command]
async fn tts_play(
    player: State<'_, Arc<PlayerHandle>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(clip) = request.body() else {
        return Err("tts_play takes the clip as a raw body, not as JSON".to_owned());
    };
    let clip = clip.clone();
    let handle = player.inner().clone();
    tauri::async_runtime::spawn_blocking(move || handle.play(&clip))
        .await
        .map_err(|cause| format!("the clip could not be played: {cause}"))?
}

/// Cuts off whatever is playing, which is also what makes the pending
/// [`tts_play`] return.
///
/// Synchronous, like `derived_schema_version` and for the same reason: it posts
/// one message to the audio thread and waits for nothing, so the main thread is
/// the cheapest place to answer it from — and `stopSpeaking()` is called on the
/// path to every new phrase, where a round trip through the pool would be pure
/// latency.
#[cfg(all(feature = "speech", desktop))]
#[tauri::command]
fn tts_stop(player: State<'_, Arc<PlayerHandle>>) {
    player.stop();
}

// -- A video's captions -----------------------------------------------------
//
// Three commands, desktop targets only, and no managed state between them:
// there is no engine to keep warm and no lock to take — each one runs a program
// and reads what it wrote. Everything about *which* track is worth fetching and
// what a transcript then becomes stays in `src/lib/media/captions.ts` and
// `src/lib/reading/subtitles.ts`, which are the same modules the web build
// runs; this host does not parse a caption file and must not learn how.

/// Whether yt-dlp and Deno are on this machine's PATH, and at what versions.
///
/// Cheap and lock-free — two `--version` calls — because the composer asks it
/// on every visit to decide whether to offer the action at all. `async` for the
/// reason the two `_status` commands are: it waits on two child processes, and
/// the main thread is the GTK loop that composites the window.
#[cfg(desktop)]
#[tauri::command]
async fn captions_status() -> Result<captions::CaptionsStatus, String> {
    tauri::async_runtime::spawn_blocking(captions::status)
        .await
        .map_err(|cause| format!("the caption tools could not be probed: {cause}"))
}

/// Every caption track a video has, manual ones first.
///
/// `async` because yt-dlp takes seconds over this — it fetches the watch page
/// and runs the player's JavaScript — and a synchronous command would freeze
/// the window for all of it.
#[cfg(desktop)]
#[tauri::command]
async fn captions_list(url: String) -> Result<captions::CaptionsListing, String> {
    tauri::async_runtime::spawn_blocking(move || captions::list(&url))
        .await
        .map_err(|cause| format!("yt-dlp could not be started: {cause}"))?
}

/// One track, as raw `json3` text.
///
/// The host does not parse it: `src/lib/reading/subtitles.ts` already reads SRT
/// and VTT and is tested, and a second parser here would be one that silently
/// disagrees with the first. So this is text in the return value, not a typed
/// cue list — and unlike audio it is small enough that JSON is the right
/// carrier: a long transcript is a few hundred kilobytes of the string it
/// already is, with nothing to re-encode.
///
/// `async` for the reason [`captions_list`] is, and then some — this one waits
/// on a second network fetch as well.
#[cfg(desktop)]
#[tauri::command]
async fn captions_fetch(
    app: AppHandle,
    url: String,
    lang: String,
    auto: bool,
) -> Result<String, String> {
    // The one writable directory this host is sure of, and the same one the
    // database and the models live in.
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|cause| format!("there is nowhere to write the track: {cause}"))?;
    tauri::async_runtime::spawn_blocking(move || captions::fetch(&dir, &url, &lang, auto))
        .await
        .map_err(|cause| format!("yt-dlp could not be started: {cause}"))?
}

/// The command list. Persistence is every host's; **speech** adds eight, of
/// which the two players are desktop-only, and **captions** add three that are
/// desktop-only outright — so the two gates multiply out to four arms rather
/// than three, and each one is written out because `generate_handler!` takes a
/// literal list and not a computed one.
#[cfg(all(feature = "speech", desktop))]
macro_rules! commands {
    () => {
        tauri::generate_handler![
            dispatch,
            commit_all,
            derived_schema_version,
            tts_status,
            tts_download,
            tts_synthesize,
            tts_play,
            tts_stop,
            asr_status,
            asr_download,
            asr_transcribe,
            captions_status,
            captions_list,
            captions_fetch
        ]
    };
}

#[cfg(all(feature = "speech", not(desktop)))]
macro_rules! commands {
    () => {
        tauri::generate_handler![
            dispatch,
            commit_all,
            derived_schema_version,
            tts_status,
            tts_download,
            tts_synthesize,
            asr_status,
            asr_download,
            asr_transcribe
        ]
    };
}

#[cfg(all(not(feature = "speech"), desktop))]
macro_rules! commands {
    () => {
        tauri::generate_handler![
            dispatch,
            commit_all,
            derived_schema_version,
            captions_status,
            captions_list,
            captions_fetch
        ]
    };
}

#[cfg(all(not(feature = "speech"), not(desktop)))]
macro_rules! commands {
    () => {
        tauri::generate_handler![dispatch, commit_all, derived_schema_version]
    };
}

/// Opens the database and runs the window.
///
/// On Android this *is* the entry point, and there is no `main` (`main.rs`):
/// the attribute wraps this in the `start_app` symbol that `TauriActivity`
/// calls once it has loaded `libsapling_desktop.so` out of the APK. On a
/// desktop it expands to nothing and the binary calls this directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Tauri's per-app data directory: `~/.local/share/<identifier>` on
            // Linux, `~/Library/Application Support/<identifier>` on macOS,
            // `%APPDATA%\<identifier>` on Windows.
            let dir = app.path().app_data_dir()?;
            // A file that will not open is not a reason to have no window: the
            // failure is managed alongside the core and answered to the first
            // call, and the layout shows it (see `host::Database`).
            let database = Database::open(&dir);
            if let Some(error) = database.error() {
                eprintln!("{error}");
            }
            // Managed behind an `Arc` because the persistence commands are
            // `async`: `spawn_blocking` needs something owned and `'static`,
            // and a `State` borrow is neither. Same shape as `TtsHandle`.
            app.manage(Arc::new(database));
            // Nothing is downloaded, loaded or opened here — the two speech
            // handles only know where their models would be, and the player has
            // not touched an audio device. The first tap on 🔊 or 🎤 pays for
            // its own.
            #[cfg(feature = "speech")]
            {
                app.manage(Arc::new(TtsHandle::new(&dir)));
                app.manage(Arc::new(AsrHandle::new(&dir)));
            }
            #[cfg(all(feature = "speech", desktop))]
            app.manage(Arc::new(PlayerHandle::new()));
            Ok(())
        })
        .invoke_handler(commands!())
        .run(tauri::generate_context!())
        .expect("the Tauri app runs");
}
