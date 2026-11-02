//! The real runtime and, where installed, the real models in the app's own
//! directory. With no model installed the model test prints why and passes;
//! `installs_the_models` (ignored) is how a machine gets them.

use std::path::PathBuf;

use sapling_ocr::{models, OcrHandle, Raster};

/// Tauri's app-data directory for `app.sapling.desktop` (Linux and macOS);
/// `SAPLING_APP_DATA` overrides it.
fn app_data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("SAPLING_APP_DATA") {
        return Some(PathBuf::from(dir));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support/app.sapling.desktop"));
    }
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    Some(data.join("app.sapling.desktop"))
}

#[test]
fn the_runtime_sherpa_onnx_links_answers() {
    // `ort` links nothing of its own, so a runtime that answers is sherpa's.
    let info = sapling_ocr::runtime_info();
    assert!(info.starts_with("ORT Build Info"), "{info}");
}

#[test]
fn a_blank_page_reads_as_no_lines() {
    let Some(dir) = app_data_dir() else {
        return;
    };
    let set = models::set("zh-mobile").unwrap();
    let ocr_dir = dir.join("ocr");
    if ![set.det, set.rec, set.dict]
        .iter()
        .all(|file| file.installed_in(&ocr_dir))
    {
        eprintln!(
            "skipped: zh-mobile is not installed in {}",
            ocr_dir.display()
        );
        return;
    }
    let data = vec![255u8; 640 * 480 * 4];
    let raster = Raster {
        data: &data,
        width: 640,
        height: 480,
    };
    let result = OcrHandle::new(&dir)
        .read_page(&raster, "zh-mobile", &|_, _, _| {})
        .unwrap();
    assert!(result.lines.is_empty());
}

#[test]
#[ignore = "downloads every OCR model (~230 MB) into the app's directory"]
fn installs_the_models() {
    let dir = app_data_dir().expect("a home directory").join("ocr");
    for set in models::SETS {
        for file in [set.det, set.rec, set.dict] {
            file.install(&dir, &|_, _, _| {}).unwrap();
        }
    }
}
