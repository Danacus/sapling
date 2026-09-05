// Everything is in the library, so `tests/` can open the core without a webview.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sapling_desktop::run();
}
