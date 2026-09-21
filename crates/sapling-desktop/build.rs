//! Tauri's build step.
//!
//! There used to be a second job here — `-Wl,-rpath,$ORIGIN`, because the old
//! sherpa binding crate linked sherpa-onnx and onnxruntime *dynamically* and
//! dropped the two `.so` files beside the binaries without an rpath, so every
//! desktop build linked fine and died at startup. `sherpa-onnx` links
//! statically on desktop targets and that whole class of problem is gone.
//!
//! Android is the exception, and not by choice: `sherpa-onnx-sys` forces shared
//! linking there and packages those libraries itself. It finds a Tauri project
//! beside Cargo's target directory, so the Android command gives this workspace
//! member its own `target/` beside `tauri.conf.json`; see `package.json`.

fn main() {
    tauri_build::build();
}
