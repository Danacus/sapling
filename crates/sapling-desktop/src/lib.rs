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
//! Persistence is not the only thing a host can lend, though. The `tts` module
//! (feature `tts`, on by default) is the second: Kokoro speech, which the
//! browser runs as sherpa-onnx compiled to WASM and this host runs natively,
//! because WebKitGTK cannot run that WASM path at all. It is still a *host*
//! capability — text in, a WAV file out, no domain knowledge whatsoever — and
//! `src/lib/tts/native.ts` is the other end of it.

//! The crate denies `unsafe_code` rather than forbidding it, for exactly one
//! module: `tts::kokoro`, which is the FFI call into sherpa-onnx and says at
//! its top why it could not be someone else's safe wrapper. Nothing else here
//! may opt out.

#![deny(unsafe_code)]

pub mod host;
#[cfg(feature = "tts")]
pub mod tts;

#[cfg(feature = "tts")]
use std::sync::Arc;

#[cfg(feature = "tts")]
use tauri::{AppHandle, Emitter};
use tauri::{Manager, State};

use crate::host::CoreHandle;
#[cfg(feature = "tts")]
use crate::tts::TtsHandle;

/// One `Backend` call. The answer is `None` — JavaScript's `undefined` — for a
/// `void` method and for a read of a row that is not there.
#[tauri::command]
fn dispatch(
    core: State<'_, CoreHandle>,
    method: String,
    args: String,
) -> Result<Option<String>, String> {
    core.dispatch(method, args)
}

/// Appends local facts in one transaction. Here for parity with `WasmCore`;
/// only a test rig seeds a store this way.
#[tauri::command]
fn commit_all(core: State<'_, CoreHandle>, facts: String) -> Result<(), String> {
    core.commit_all(facts)
}

/// The read-table shape this build expects — the version `meta` records.
#[tauri::command]
fn derived_schema_version() -> u32 {
    sapling_core::schema::DERIVED_SCHEMA_VERSION
}

// -- The native voice -------------------------------------------------------
//
// Three commands, and deliberately no more: is it here, put it here, say this.
// Everything about *what* to speak — the language mapping, the speaker table,
// the caches, the fallback to the browser voice — stays in `src/lib/tts/`,
// which is the same code the web build runs.

/// Event carrying one file's download progress to the window. Its three fields
/// are `TtsProgress`'s, so `native.ts` can feed the existing progress listener.
#[cfg(feature = "tts")]
#[derive(Clone, serde::Serialize)]
struct DownloadProgress {
    file: String,
    loaded: u64,
    total: u64,
}

/// The channel the progress events travel on. Named once here and once in
/// `native.ts`.
#[cfg(feature = "tts")]
const TTS_PROGRESS_EVENT: &str = "tts://model-progress";

/// Whether the voice model is on this machine, and what it costs.
#[cfg(feature = "tts")]
#[tauri::command]
fn tts_status(tts: State<'_, Arc<TtsHandle>>) -> tts::TtsStatus {
    tts.status()
}

/// Downloads and unpacks the voice model, reporting progress as it goes.
///
/// `async` on purpose: a synchronous Tauri command runs on the main thread, and
/// this one runs for minutes. Idempotent — an installed model returns at once.
#[cfg(feature = "tts")]
#[tauri::command]
async fn tts_download(app: AppHandle, tts: State<'_, Arc<TtsHandle>>) -> Result<(), String> {
    let handle = tts.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle.install(&|file: &str, loaded: u64, total: u64| {
            // A failed emit means the window is gone; the download may as well
            // finish, and the next boot then finds the model already here.
            let _ = app.emit(
                TTS_PROGRESS_EVENT,
                DownloadProgress {
                    file: file.to_owned(),
                    loaded,
                    total,
                },
            );
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
#[cfg(feature = "tts")]
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

/// The command list, which the `tts` feature extends rather than replaces.
#[cfg(feature = "tts")]
macro_rules! commands {
    () => {
        tauri::generate_handler![
            dispatch,
            commit_all,
            derived_schema_version,
            tts_status,
            tts_download,
            tts_synthesize
        ]
    };
}

#[cfg(not(feature = "tts"))]
macro_rules! commands {
    () => {
        tauri::generate_handler![dispatch, commit_all, derived_schema_version]
    };
}

/// Opens the database and runs the window.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Tauri's per-app data directory: `~/.local/share/<identifier>` on
            // Linux, `~/Library/Application Support/<identifier>` on macOS,
            // `%APPDATA%\<identifier>` on Windows.
            let dir = app.path().app_data_dir()?;
            app.manage(CoreHandle::open(&dir)?);
            // Nothing is downloaded or loaded here — the handle only knows
            // where the model would be. The first tap on 🔊 pays for the rest.
            #[cfg(feature = "tts")]
            app.manage(Arc::new(TtsHandle::new(&dir)));
            Ok(())
        })
        .invoke_handler(commands!())
        .run(tauri::generate_context!())
        .expect("the Tauri app runs");
}
