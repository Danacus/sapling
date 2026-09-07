//! What both speech tests need and neither can ask Tauri for.
//!
//! `tests/voice.rs` and `tests/dictation.rs` run against the *real* models in
//! the *real* place the app keeps them, so both have to work out the app-data
//! directory by hand — there is no `App` in a test to call
//! `app.path().app_data_dir()` on. A directory, not a test target: cargo
//! compiles every `tests/*.rs` as its own binary and leaves `tests/*/` alone.

use std::path::PathBuf;

/// Tauri's app-data directory for `app.sapling.desktop` — the same path
/// `lib.rs` gets from `app.path().app_data_dir()`. `SAPLING_APP_DATA`
/// overrides it.
pub fn app_data_dir() -> Option<PathBuf> {
    const IDENTIFIER: &str = "app.sapling.desktop";

    if let Some(overridden) = std::env::var_os("SAPLING_APP_DATA") {
        return Some(PathBuf::from(overridden));
    }
    if cfg!(target_os = "windows") {
        return std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join(IDENTIFIER));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support").join(IDENTIFIER));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    Some(data.join(IDENTIFIER))
}
