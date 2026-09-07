fn main() {
    // `sherpa-rs-sys` links sherpa-onnx and onnxruntime *dynamically* and drops
    // the two `.so` files next to the binaries it builds (`target/<profile>/`
    // and `target/<profile>/deps/`, so tests find them too). It adds no rpath,
    // though, so without this the linker is happy and the program dies at
    // startup with `libsherpa-onnx-c-api.so: cannot open shared object file`.
    // `$ORIGIN` is resolved by the loader against the executable's own
    // directory, which is exactly where those files were put.
    if voice() {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    }

    tauri_build::build();
}

/// Whether this build has the native voice: the `tts` feature, on a target its
/// dependencies are declared for. Mirrors `Cargo.toml`'s target table and the
/// `all(feature = "tts", desktop)` the code is gated on.
///
/// A build script runs on the machine doing the building, so `cfg!(target_os)`
/// here would answer for *that* machine and be quietly wrong the moment a
/// laptop cross-compiles for a phone. `CARGO_CFG_TARGET_OS` is the same
/// question asked of the target, and it is the reason this is a function and
/// not an attribute. `cfg!(feature = …)` is fine — a build script is compiled
/// with its package's features.
fn voice() -> bool {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    cfg!(feature = "tts") && target_os != "android" && target_os != "ios"
}
