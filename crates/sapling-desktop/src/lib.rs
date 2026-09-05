//! Sapling on the desktop: a Tauri v2 shell around `sapling-core`.
//!
//! The app is the same SvelteKit SPA the web ships, loaded into a webview; the
//! only thing that changes is where persistence lives. In the browser the core
//! is compiled to wasm and runs inside a Worker over sqlite-wasm in OPFS
//! (`src/lib/db/sqlite.worker.ts`); here it runs natively over a SQLite *file*
//! in the app-data directory, and the window reaches it through the same
//! domain-level protocol — `dispatch(method, argsJson)` in, JSON out.
//!
//! **This crate is a host and nothing else.** The three commands below are the
//! exact surface `WasmCore` exposes to the Worker, name for name, so neither
//! side can grow a method the other lacks; every merge rule, every read and
//! every line of SQL against the read tables stays in `sapling-core`.

#![forbid(unsafe_code)]

pub mod host;

use tauri::{Manager, State};

use crate::host::CoreHandle;

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

/// Opens the database and runs the window.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Tauri's per-app data directory: `~/.local/share/<identifier>` on
            // Linux, `~/Library/Application Support/<identifier>` on macOS,
            // `%APPDATA%\<identifier>` on Windows.
            let dir = app.path().app_data_dir()?;
            app.manage(CoreHandle::open(&dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dispatch,
            commit_all,
            derived_schema_version
        ])
        .run(tauri::generate_context!())
        .expect("the Tauri app runs");
}
