//! Tauri's build step.
//!
//! There used to be a second job here — `-Wl,-rpath,$ORIGIN`, because the old
//! sherpa binding crate linked sherpa-onnx and onnxruntime *dynamically* and
//! dropped the two `.so` files beside the binaries without an rpath, so every
//! desktop build linked fine and died at startup. `sherpa-onnx` links
//! statically on desktop targets and that whole class of problem is gone.
//!
//! Android is the exception, and not by choice: `sherpa-onnx-sys` forces shared
//! linking there. The generated Gradle [`BuildTask.kt`](gen/android/buildSrc/src/main/java/app/sapling/desktop/kotlin/BuildTask.kt)
//! packages those libraries *after* Cargo returns. It cannot happen here:
//! Cargo may run this build script before a normal dependency's build script
//! has finished, so copying the archive that `sherpa-onnx-sys` extracts would
//! race on a cold cache.

fn main() {
    tauri_build::build();
}
