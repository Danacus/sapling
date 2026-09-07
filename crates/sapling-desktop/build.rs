//! Tauri's own build step, plus the one thing an Android build needs a build
//! script for: getting sherpa-onnx into the APK.
//!
//! There used to be a second job here — `-Wl,-rpath,$ORIGIN`, because the old
//! sherpa binding crate linked sherpa-onnx and onnxruntime *dynamically* and
//! dropped the two `.so` files beside the binaries without an rpath, so every
//! desktop build linked fine and died at startup. `sherpa-onnx` links
//! statically on desktop targets and that whole class of problem is gone.
//!
//! Android is the exception, and not by choice: `sherpa-onnx-sys` forces shared
//! linking there whatever the features say, because that is the only thing
//! k2-fsa publishes for the platform. So `libsherpa-onnx-c-api.so` and
//! `libonnxruntime.so` have to be *packaged*, and nothing packages them by
//! itself — Tauri's Gradle plugin copies exactly one file, the crate's own
//! `libsapling_desktop.so`. [`package_sherpa_into_the_apk`] is that missing
//! step, and it is here rather than in CI so that any `pnpm desktop:android`
//! produces an APK that runs.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    // Not `cfg!(target_os = …)`: a build script is compiled for the machine
    // doing the building, so that would answer for the laptop the moment it
    // cross-compiles for a phone. `cfg!(feature = …)` is fine — a build script
    // does get its package's features.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if cfg!(feature = "speech") && target_os == "android" {
        package_sherpa_into_the_apk();
    }

    tauri_build::build();
}

/// The two shared libraries native speech needs at runtime on a phone — the
/// voice and the recognizer are one library between them.
///
/// Only these two. The archive also carries `libsherpa-onnx-jni.so` (4.8 MB)
/// and `libsherpa-onnx-cxx-api.so`, which are the JNI and C++ front doors, and
/// this host goes in through the C API. It carries no `libc++_shared.so` and
/// needs none: `readelf -d` on both of these lists only `libandroid`, `liblog`,
/// `libm`, `libdl`, `libc` and — for the c-api one — `libonnxruntime`, so the
/// C++ runtime is statically linked inside them. `libonnxruntime.so` is
/// resolved out of the APK's own lib directory, which is where Android's loader
/// looks for a `DT_NEEDED` name, so no rpath is involved on this platform
/// either.
const SHERPA_LIBS: [&str; 2] = ["libsherpa-onnx-c-api.so", "libonnxruntime.so"];

/// Copies those two into the committed Android project's `jniLibs/<abi>/`,
/// where Gradle will pick them up.
///
/// **The ordering is safe and it is not luck.** `sherpa-onnx-sys` declares
/// `links = "sherpa-onnx"`, and cargo runs the build script of a `links`
/// dependency before the build script of the crate that depends on it — so by
/// the time this runs, the archive has been downloaded and extracted. Without
/// that key the two would race and a cold cache would lose.
///
/// Loud on failure, deliberately: nobody here has an Android SDK, so this code
/// only ever runs in CI, and an APK that quietly shipped without a voice would
/// be found on a phone rather than in a log.
fn package_sherpa_into_the_apk() {
    let abi = android_abi(&env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default());
    let source = sherpa_android_lib_dir(abi);
    let destination = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"))
        .join("gen/android/app/src/main/jniLibs")
        .join(abi);

    fs::create_dir_all(&destination)
        .unwrap_or_else(|e| panic!("could not create {}: {e}", destination.display()));

    for lib in SHERPA_LIBS {
        let from = source.join(lib);
        let to = destination.join(lib);
        let bytes = fs::copy(&from, &to).unwrap_or_else(|e| {
            panic!(
                "speech needs {} in the APK and it is not at {}: {e}\n\
                 sherpa-onnx-sys downloads the Android archive into \
                 <target>/sherpa-onnx-prebuilt/; see crates/sapling-desktop/build.rs.",
                lib,
                from.display()
            )
        });
        // A build script's stdout is cargo's, so this is the one channel that
        // reaches a CI log. Worth the noise: it is the only place the APK's
        // contents are decided.
        println!(
            "cargo:warning=packaged {} ({bytes} bytes) into {}",
            lib,
            to.display()
        );
    }

    // The version this reads and the override it honours. Whether this script
    // reruns at all is cargo's business and not a thing to bet an APK on, so
    // the workflow checks the finished APK for these two libraries rather than
    // trusting that the copy happened.
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-env-changed=SHERPA_ONNX_LIB_DIR");
}

/// Where `sherpa-onnx-sys` left the Android libraries.
///
/// Derived rather than asked for: that crate sets `SHERPA_ONNX_LIB_DIR` only
/// inside its *own* build script process, and a `links` crate passes metadata
/// on only if it prints `cargo:<key>=<value>`, which it does not. So the layout
/// is reproduced here — `<target-dir>/sherpa-onnx-prebuilt/sherpa-onnx-v<the
/// pinned version>-android/jniLibs/<abi>` — with the same `SHERPA_ONNX_LIB_DIR`
/// override honoured, so a machine pointing the sys crate at its own libraries
/// points this at them too.
fn sherpa_android_lib_dir(abi: &str) -> PathBuf {
    if let Some(overridden) = env::var_os("SHERPA_ONNX_LIB_DIR") {
        return PathBuf::from(overridden);
    }
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("cargo sets this"));
    cargo_target_dir(&out_dir)
        .join("sherpa-onnx-prebuilt")
        .join(format!("sherpa-onnx-v{}-android", pinned_sherpa_version()))
        .join("jniLibs")
        .join(abi)
}

/// `CARGO_TARGET_DIR`, or the ancestor of `OUT_DIR` called `target` — which is
/// how `sherpa-onnx-sys` finds the same directory, and the two must agree.
fn cargo_target_dir(out_dir: &Path) -> PathBuf {
    if let Some(explicit) = env::var_os("CARGO_TARGET_DIR") {
        return PathBuf::from(explicit);
    }
    out_dir
        .ancestors()
        .find(|path| path.file_name() == Some(std::ffi::OsStr::new("target")))
        .unwrap_or(out_dir)
        .to_path_buf()
}

/// The `sherpa-onnx` version this crate pins, read out of the manifest beside
/// this file.
///
/// **The version is the sherpa-onnx release tag**, which is why it is read
/// rather than repeated: the archive is named after it, so a copy here could go
/// stale against `Cargo.toml` and send this looking in a directory that will
/// never exist. Requires the dependency to be one line starting at column 0,
/// which is what rustfmt-adjacent tooling leaves it as; the panic says so.
fn pinned_sherpa_version() -> String {
    include_str!("Cargo.toml")
        .lines()
        .find_map(|line| line.strip_prefix("sherpa-onnx = "))
        .and_then(|rest| rest.split_once("version = \""))
        .and_then(|(_, rest)| rest.split('"').next())
        .map(|version| version.trim_start_matches('=').to_owned())
        .expect("Cargo.toml declares `sherpa-onnx = { version = \"=x.y.z\", … }` on one line")
}

/// Rust's target architecture as the ABI directory Android names it, which is
/// also what the archive's `jniLibs/` is keyed by.
fn android_abi(target_arch: &str) -> &'static str {
    match target_arch {
        "aarch64" => "arm64-v8a",
        "arm" => "armeabi-v7a",
        "x86" => "x86",
        "x86_64" => "x86_64",
        other => panic!("no Android ABI is known for target arch {other}"),
    }
}
