// Everything is in the library, so `tests/` can open the core without a webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(desktop)]
fn main() {
    sapling_desktop::run();
}

// On Android the app is the *library*: `TauriActivity` loads
// `libsapling_desktop.so` and calls the `start_app` that `mobile_entry_point`
// generates over `run()`. Gradle nonetheless builds this target too — it runs
// `cargo build` over the whole package, with no `--lib` — so here it is
// deliberately empty rather than an executable nothing on the phone could
// launch.
#[cfg(mobile)]
fn main() {}
