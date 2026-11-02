//! OCR for a page image on a native host: PP-OCRv5 (detector + recognizer) on
//! ONNX Runtime with all cores, behind `src/lib/ocr`'s `ocrPage`.
//!
//! [`pipeline`] is `src/lib/ocr/pipeline.ts` in Rust, [`models`] the same pins
//! as `models.ts`. The runtime is the one sherpa-onnx links (see `Cargo.toml`).

#![forbid(unsafe_code)]

pub mod models;
pub mod pipeline;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use ort::environment::Environment;
use ort::session::Session;
use ort::value::TensorRef;
use sapling_models::{available_threads, ModelFile};
use serde::Serialize;

pub use pipeline::{OcrLine, Raster};

// Named so rustc links it: its onnxruntime is the one `ort` calls into.
use sherpa_onnx_sys as _;

/// rustc puts `sherpa-onnx-sys` before `ort` on the link line, and a
/// single-pass linker would not go back for `ort`'s `OrtGetApiBase`; a
/// reference from this crate, which comes first, pulls it in ahead of both.
fn link_runtime() {
    std::hint::black_box(ort_sys::OrtGetApiBase as *const ());
}

/// `stage`, `done`, `total` — `OcrProgress` in `src/lib/ocr/index.ts`.
pub type OnProgress<'a> = &'a (dyn Fn(&str, u64, u64) + Send + Sync);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTimings {
    /// Downloading (first time) and creating the sessions; ~0 once warm.
    pub load_ms: f64,
    pub page_ms: f64,
}

#[derive(Serialize)]
pub struct OcrResult {
    pub lines: Vec<OcrLine>,
    pub timings: OcrTimings,
    pub backend: String,
}

struct Loaded {
    set: &'static str,
    det: Session,
    rec: Session,
    dict: Vec<String>,
}

/// One page at a time, and only the newest: the viewer shows one page, so a
/// request a later one overtook while it waited answers `superseded`.
pub struct OcrHandle {
    dir: PathBuf,
    loaded: Mutex<Option<Loaded>>,
    latest: AtomicU64,
}

fn environment() -> Result<&'static Environment, String> {
    link_runtime();
    static ENV: OnceLock<Environment> = OnceLock::new();
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = ort::init()
        .with_name("sapling-ocr")
        .build()
        .map_err(|e| format!("ONNX Runtime did not start: {e}"))?;
    Ok(ENV.get_or_init(|| env))
}

fn session(path: &Path) -> Result<Session, String> {
    let threads = available_threads().max(1) as usize;
    Session::builder(environment()?)
        .and_then(|builder| Ok(builder.with_intra_threads(threads)?))
        .and_then(|mut builder| builder.commit_from_file(path))
        .map_err(|e| format!("could not load {}: {e}", path.display()))
}

/// The linked runtime's build string — sherpa-onnx's ONNX Runtime.
pub fn runtime_info() -> String {
    link_runtime();
    ort::info().to_owned()
}

impl OcrHandle {
    /// Models live in `<app-data>/ocr`.
    pub fn new(app_data: &Path) -> Self {
        Self {
            dir: app_data.join("ocr"),
            loaded: Mutex::new(None),
            latest: AtomicU64::new(0),
        }
    }

    pub fn read_page(
        &self,
        raster: &Raster,
        set_id: &str,
        on_progress: OnProgress<'_>,
    ) -> Result<OcrResult, String> {
        let ticket = self.latest.fetch_add(1, Ordering::SeqCst) + 1;
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        if self.latest.load(Ordering::SeqCst) != ticket {
            return Err("superseded".to_owned());
        }
        let set = models::set(set_id).ok_or_else(|| format!("no OCR model set {set_id}"))?;
        let started = Instant::now();
        if loaded.as_ref().is_none_or(|models| models.set != set.id) {
            *loaded = None;
            *loaded = Some(self.load(set, on_progress)?);
        }
        let models = loaded.as_mut().expect("loaded above");
        let load_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let lines = recognize(raster, models, on_progress)?;
        Ok(OcrResult {
            lines,
            timings: OcrTimings {
                load_ms,
                page_ms: started.elapsed().as_secs_f64() * 1000.0,
            },
            backend: format!("native · {} threads", available_threads()),
        })
    }

    fn load(
        &self,
        set: &'static models::ModelSet,
        on_progress: OnProgress<'_>,
    ) -> Result<Loaded, String> {
        let fetch = |file: &ModelFile, label: &str| {
            let stage = format!("Downloading {label}");
            file.install(&self.dir, &|_: &str, done, total| {
                on_progress(&stage, done, total)
            })
        };
        let det = fetch(set.det, "detector")?;
        let rec = fetch(set.rec, "recognizer")?;
        let dict = fetch(set.dict, "dictionary")?;
        on_progress("Starting the models", 0, 0);
        let dict = std::fs::read_to_string(&dict)
            .map_err(|e| format!("could not read {}: {e}", dict.display()))?;
        Ok(Loaded {
            set: set.id,
            det: session(&det)?,
            rec: session(&rec)?,
            dict: dict.lines().map(str::to_owned).collect(),
        })
    }
}

fn recognize(
    raster: &Raster,
    models: &mut Loaded,
    on_progress: OnProgress<'_>,
) -> Result<Vec<OcrLine>, String> {
    let fail = |e: ort::Error| format!("the text reader failed: {e}");
    let input = pipeline::det_input(raster, pipeline::DET_LIMIT);
    let boxes = {
        let tensor = TensorRef::from_array_view((input.tensor.dims, &input.tensor.data[..]))
            .map_err(fail)?;
        let out = models.det.run(ort::inputs![tensor]).map_err(fail)?;
        let (shape, prob) = out[0].try_extract_tensor::<f32>().map_err(fail)?;
        let (h, w) = (shape[2] as usize, shape[3] as usize);
        pipeline::det_boxes(prob, h, w, &input, raster)
    };
    let mut lines = Vec::new();
    for (i, bbox) in boxes.iter().enumerate() {
        on_progress("Reading lines", i as u64, boxes.len() as u64);
        let crop = pipeline::rec_input(raster, bbox);
        let tensor = TensorRef::from_array_view((crop.dims, &crop.data[..])).map_err(fail)?;
        let out = models.rec.run(ort::inputs![tensor]).map_err(fail)?;
        let (shape, logits) = out[0].try_extract_tensor::<f32>().map_err(fail)?;
        let line = pipeline::rec_decode(
            logits,
            shape[1] as usize,
            shape[2] as usize,
            crop.dims[3],
            *bbox,
            &models.dict,
        );
        if !line.text.trim().is_empty() {
            lines.push(line);
        }
    }
    Ok(lines)
}
