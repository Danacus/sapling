fn main() {
    // `sherpa-rs-sys` links sherpa-onnx and onnxruntime *dynamically* and drops
    // the two `.so` files next to the binaries it builds (`target/<profile>/`
    // and `target/<profile>/deps/`, so tests find them too). It adds no rpath,
    // though, so without this the linker is happy and the program dies at
    // startup with `libsherpa-onnx-c-api.so: cannot open shared object file`.
    // `$ORIGIN` is resolved by the loader against the executable's own
    // directory, which is exactly where those files were put.
    #[cfg(feature = "tts")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");

    tauri_build::build();
}
