//! Nothing but Tauri's own build step.
//!
//! It used to add `-Wl,-rpath,$ORIGIN` for the voice: the previous sherpa
//! binding crate linked sherpa-onnx and onnxruntime *dynamically* and dropped
//! the two `.so` files beside the binaries without an rpath, so every desktop
//! build linked fine and died at startup. `sherpa-onnx` links statically on
//! desktop targets, so there are no libraries to find and no rpath to add.

fn main() {
    tauri_build::build();
}
