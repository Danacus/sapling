//! A local recording, read natively: how long and how big it is, its audio as
//! 16 kHz mono PCM, and a grey crop of the frame at any moment.
//!
//! A host capability with no opinion, like `sapling-ocr`: a file in, samples
//! and rasters out. What they are for — a transcript, and the burnt-in
//! subtitles that may correct it — is the window's (`src/lib/tasks/kinds/
//! transcribe.ts`) and `sapling-import`'s.
//!
//! It is native because the webview could not do it (measured on WebKitGTK
//! 2.52 / GStreamer 1.28, a 26-minute 1080p60 AV1/Opus file): `decodeAudioData`
//! took 285 s and ~800 MB for the whole file, and a seeked `<video>` drawn to a
//! canvas read back blank or noise. Here the audio decodes in ~5 s, and frames
//! come from one decoder kept open per file and walked forward.
//!
//! The window cannot hand over a path (a picked `File` has none), so the bytes
//! are staged into a file under the cache directory in chunks
//! ([`MediaHandle::stage`]) and removed by [`MediaHandle::release`]; a crash's
//! leftovers are swept when the handle is made. Nothing is kept.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSink;
use gstreamer_pbutils::Discoverer;
use gstreamer_video::{VideoFrameRef, VideoInfo};
use serde::Serialize;

/// The rate and layout [`MediaHandle::audio`] answers: what the recognizer wants.
pub const SAMPLE_RATE: u32 = 16_000;

/// Beyond this far ahead, a frame is reached by seeking rather than by decoding
/// forward to it — about one keyframe interval of a typical encode.
const FORWARD_NS: u64 = 3_000_000_000;

/// How long any one wait on the pipeline may take before it is a failure.
const WAIT_S: u64 = 20;

/// What [`MediaHandle::probe`] answers. camelCase for the window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration_ms: f64,
    /// 0 for a file with no picture.
    pub width: u32,
    pub height: u32,
    pub audio: bool,
}

/// A rectangle in the frame's own pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The staging directory and one open frame decoder per staged file.
pub struct MediaHandle {
    dir: PathBuf,
    cursors: Mutex<HashMap<String, Arc<Mutex<FrameCursor>>>>,
}

/// Whether GStreamer loads at all — a host without it lends none of this.
pub fn available() -> bool {
    gst::init().is_ok()
}

impl MediaHandle {
    /// A handle staging under `<cache>/media`, sweeping what a crash left there.
    pub fn new(cache_dir: &Path) -> MediaHandle {
        let dir = cache_dir.join("media");
        let _ = fs::remove_dir_all(&dir);
        MediaHandle {
            dir,
            cursors: Mutex::new(HashMap::new()),
        }
    }

    fn path_of(&self, id: &str) -> Result<PathBuf, String> {
        let valid = !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid {
            return Err(format!("{id:?} is not a media id"));
        }
        Ok(self.dir.join(id))
    }

    /// Writes `bytes` at `offset` of the staged file `id`; offset 0 starts it
    /// over. Chunks must arrive in order.
    pub fn stage(&self, id: &str, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let path = self.path_of(id)?;
        fs::create_dir_all(&self.dir).map_err(|e| format!("could not stage the file: {e}"))?;
        if offset == 0 {
            self.drop_cursor(id);
        }
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(offset == 0)
            .append(offset > 0)
            .open(&path)
            .map_err(|e| format!("could not stage the file: {e}"))?;
        let len = file.metadata().map(|m| m.len()).unwrap_or(0);
        if len != offset {
            return Err(format!(
                "a chunk for offset {offset} arrived with {len} bytes staged"
            ));
        }
        file.write_all(bytes)
            .map_err(|e| format!("could not stage the file: {e}"))
    }

    /// Removes the staged file and closes its decoder.
    pub fn release(&self, id: &str) {
        self.drop_cursor(id);
        if let Ok(path) = self.path_of(id) {
            let _ = fs::remove_file(path);
        }
    }

    fn drop_cursor(&self, id: &str) {
        if let Some(cursor) = self.cursors.lock().ok().and_then(|mut c| c.remove(id)) {
            if let Ok(cursor) = cursor.lock() {
                let _ = cursor.pipeline.set_state(gst::State::Null);
            }
        }
    }

    fn staged(&self, id: &str) -> Result<PathBuf, String> {
        let path = self.path_of(id)?;
        if !path.is_file() {
            return Err("that file is not staged".to_owned());
        }
        gst::init().map_err(|e| format!("GStreamer did not load: {e}"))?;
        Ok(path)
    }

    /// Length, picture size and whether there is sound.
    pub fn probe(&self, id: &str) -> Result<MediaInfo, String> {
        let path = self.staged(id)?;
        let uri = gst::glib::filename_to_uri(&path, None)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let info = Discoverer::new(gst::ClockTime::from_seconds(WAIT_S))
            .and_then(|discoverer| discoverer.discover_uri(&uri))
            .map_err(|e| format!("could not read that recording: {e}"))?;
        let video = info.video_streams().into_iter().next();
        Ok(MediaInfo {
            duration_ms: info.duration().map_or(0.0, |d| d.nseconds() as f64 / 1e6),
            width: video.as_ref().map_or(0, |v| v.width()),
            height: video.as_ref().map_or(0, |v| v.height()),
            audio: !info.audio_streams().is_empty(),
        })
    }

    /// The audio from `from_ms` to `to_ms` as 16-bit LE mono PCM at
    /// [`SAMPLE_RATE`], starting exactly at `from_ms` (cut by timestamp, not by
    /// trusting the seek). Shorter where the file ends first.
    pub fn audio(&self, id: &str, from_ms: f64, to_ms: f64) -> Result<Vec<u8>, String> {
        let path = self.staged(id)?;
        let caps = gst::Caps::builder("audio/x-raw")
            .field("format", "S16LE")
            .field("rate", SAMPLE_RATE as i32)
            .field("channels", 1)
            .field("layout", "interleaved")
            .build();
        let chain = ["audioconvert", "audioresample"];
        let (pipeline, sink) = open(&path, "audio/", &chain, &caps, None)?;
        let result = (|| {
            seek_paused(&pipeline, ns(from_ms))?;
            play(&pipeline)?;
            let (from, to) = (ns(from_ms), ns(to_ms));
            let mut out = Vec::new();
            while let Some(sample) = pull(&pipeline, &sink)? {
                let Some(buffer) = sample.buffer() else {
                    continue;
                };
                let Some(pts) = buffer.pts().map(|p| p.nseconds()) else {
                    continue;
                };
                if pts >= to {
                    break;
                }
                let map = buffer
                    .map_readable()
                    .map_err(|_| "an audio buffer could not be read")?;
                for (i, pair) in map.chunks_exact(2).enumerate() {
                    let at = pts + i as u64 * 1_000_000_000 / SAMPLE_RATE as u64;
                    if at >= from && at < to {
                        out.extend_from_slice(pair);
                    }
                }
            }
            Ok(out)
        })();
        let _ = pipeline.set_state(gst::State::Null);
        result
    }

    /// The frame on screen at `at_ms`, cropped to `rect` (clamped to the
    /// frame), as RGBA with R = G = B = luma — `rect.width × rect.height × 4`
    /// bytes after clamping, whose size the answer's first eight bytes give
    /// (two LE `u32`s). Ask in ascending time where possible: forward is a
    /// decode, backward or far ahead is a seek.
    pub fn frame(&self, id: &str, at_ms: f64, rect: Rect) -> Result<Vec<u8>, String> {
        let path = self.staged(id)?;
        let cursor = {
            let mut cursors = self.cursors.lock().map_err(|_| "the decoders failed")?;
            match cursors.get(id) {
                Some(cursor) => cursor.clone(),
                None => {
                    let cursor = Arc::new(Mutex::new(FrameCursor::open(&path)?));
                    cursors.insert(id.to_owned(), cursor.clone());
                    cursor
                }
            }
        };
        let mut cursor = cursor.lock().map_err(|_| "that decoder failed")?;
        cursor.frame_at(ns(at_ms), rect)
    }
}

fn ns(ms: f64) -> u64 {
    (ms.max(0.0) * 1e6) as u64
}

/// `filesrc ! decodebin` with the first stream whose raw caps start with
/// `wanted` linked through `chain` into an appsink limited to `caps`. Every
/// other stream is left encoded and dropped, so the video is never decoded for
/// the audio nor the audio for a frame.
fn open(
    path: &Path,
    wanted: &'static str,
    chain: &[&str],
    caps: &gst::Caps,
    max_buffers: Option<u32>,
) -> Result<(gst::Pipeline, AppSink), String> {
    let fail = |e: &dyn std::fmt::Display| format!("could not open the recording: {e}");
    let pipeline = gst::Pipeline::new();
    let src = gst::ElementFactory::make("filesrc")
        .property("location", path.to_string_lossy().as_ref())
        .build()
        .map_err(|e| fail(&e))?;
    let decode = gst::ElementFactory::make("decodebin")
        .build()
        .map_err(|e| fail(&e))?;
    let mut builder = AppSink::builder().caps(caps).sync(false);
    if let Some(max) = max_buffers {
        builder = builder.max_buffers(max).drop(false);
    }
    let sink = builder.build();
    let mut elements = vec![src.clone(), decode.clone()];
    for name in chain {
        elements.push(
            gst::ElementFactory::make(name)
                .build()
                .map_err(|e| fail(&e))?,
        );
    }
    elements.push(sink.clone().upcast());
    pipeline.add_many(&elements).map_err(|e| fail(&e))?;
    src.link(&decode).map_err(|e| fail(&e))?;
    gst::Element::link_many(&elements[2..]).map_err(|e| fail(&e))?;
    let head = elements[2].clone();

    decode.connect("autoplug-continue", false, move |args| {
        let caps = args[2].get::<gst::Caps>().ok()?;
        let name = caps.structure(0)?.name().to_string();
        // A container (`video/x-matroska`) is opened whatever it is called;
        // only an elementary stream of the other kind stops here, undecoded.
        let other = !name.starts_with(wanted)
            && (name.starts_with("audio/") || name.starts_with("video/"))
            && !gst::ElementFactory::factories_with_type(
                gst::ElementFactoryType::DEMUXER,
                gst::Rank::MARGINAL,
            )
            .into_iter()
            .any(|factory| factory.can_sink_any_caps(&caps));
        Some((!other).to_value())
    });
    let weak = pipeline.downgrade();
    decode.connect_pad_added(move |_, pad| {
        let Some(pipeline) = weak.upgrade() else {
            return;
        };
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        let raw = format!("{wanted}x-raw");
        let is_wanted = caps.structure(0).is_some_and(|s| s.name().as_str() == raw);
        let target = head.static_pad("sink").filter(|p| !p.is_linked());
        match target {
            Some(sink_pad) if is_wanted => {
                let _ = pad.link(&sink_pad);
            }
            _ => {
                let Ok(fake) = gst::ElementFactory::make("fakesink")
                    .property("sync", false)
                    .property("async", false)
                    .build()
                else {
                    return;
                };
                if pipeline.add(&fake).is_ok() {
                    let _ = fake.sync_state_with_parent();
                    if let Some(fake_pad) = fake.static_pad("sink") {
                        let _ = pad.link(&fake_pad);
                    }
                }
            }
        }
    });
    Ok((pipeline, sink))
}

fn wait(pipeline: &gst::Pipeline) -> Result<(), String> {
    let (result, _, _) = pipeline.state(gst::ClockTime::from_seconds(WAIT_S));
    result.map(|_| ()).map_err(|_| bus_error(pipeline))
}

fn seek_paused(pipeline: &gst::Pipeline, at: u64) -> Result<(), String> {
    pipeline
        .set_state(gst::State::Paused)
        .map_err(|_| bus_error(pipeline))?;
    wait(pipeline)?;
    pipeline
        .seek_simple(
            gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
            gst::ClockTime::from_nseconds(at),
        )
        .map_err(|_| "the recording could not be seeked".to_owned())?;
    wait(pipeline)
}

fn play(pipeline: &gst::Pipeline) -> Result<(), String> {
    pipeline
        .set_state(gst::State::Playing)
        .map(|_| ())
        .map_err(|_| bus_error(pipeline))
}

/// The next sample, `None` at the end of the stream.
fn pull(pipeline: &gst::Pipeline, sink: &AppSink) -> Result<Option<gst::Sample>, String> {
    match sink.try_pull_sample(gst::ClockTime::from_seconds(WAIT_S)) {
        Some(sample) => Ok(Some(sample)),
        None if sink.is_eos() => Ok(None),
        None => Err(bus_error(pipeline)),
    }
}

fn bus_error(pipeline: &gst::Pipeline) -> String {
    let message = pipeline
        .bus()
        .and_then(|bus| bus.pop_filtered(&[gst::MessageType::Error]));
    match message.as_ref().map(|m| m.view()) {
        Some(gst::MessageView::Error(error)) => {
            format!("the recording could not be decoded: {}", error.error())
        }
        _ => "the recording stopped answering".to_owned(),
    }
}

/// Planar formats whose first plane is the luma at one byte a pixel, which is
/// all a crop needs. `videoconvert` passes these through untouched.
const LUMA_FORMATS: &[&str] = &[
    "I420", "YV12", "NV12", "NV21", "Y42B", "Y444", "Y41B", "GRAY8",
];

/// One decoder over one file, kept playing and walked forward.
struct FrameCursor {
    pipeline: gst::Pipeline,
    sink: AppSink,
    /// The last frame pulled, with its span in ns.
    last: Option<(u64, u64, gst::Sample)>,
    playing: bool,
}

impl FrameCursor {
    fn open(path: &Path) -> Result<FrameCursor, String> {
        let caps = gst::Caps::builder("video/x-raw")
            .field("format", gst::List::new(LUMA_FORMATS.iter().copied()))
            .build();
        let (pipeline, sink) = open(path, "video/", &["videoconvert"], &caps, Some(1))?;
        Ok(FrameCursor {
            pipeline,
            sink,
            last: None,
            playing: false,
        })
    }

    fn frame_at(&mut self, at: u64, rect: Rect) -> Result<Vec<u8>, String> {
        if let Some((start, end, sample)) = &self.last {
            if *start <= at && at < *end {
                return crop(sample, rect);
            }
        }
        let behind = self.last.as_ref().is_none_or(|(start, _, _)| at < *start);
        let far = self
            .last
            .as_ref()
            .is_some_and(|(start, _, _)| at > start + FORWARD_NS);
        if !self.playing || behind || far {
            seek_paused(&self.pipeline, at)?;
            play(&self.pipeline)?;
            self.playing = true;
        }
        loop {
            let Some(sample) = pull(&self.pipeline, &self.sink)? else {
                // Past the end: the last picture is what is on screen.
                return match &self.last {
                    Some((_, _, sample)) => crop(sample, rect),
                    None => Err("the recording has no picture".to_owned()),
                };
            };
            let buffer = sample.buffer().ok_or("a frame without a buffer")?;
            let start = buffer.pts().map_or(at, |p| p.nseconds());
            let end = start + buffer.duration().map_or(16_666_667, |d| d.nseconds());
            self.last = Some((start, end, sample));
            if end > at {
                let (_, _, sample) = self.last.as_ref().expect("just set");
                return crop(sample, rect);
            }
        }
    }
}

/// The luma of `rect` in `sample`, as RGBA behind an eight-byte size header.
fn crop(sample: &gst::Sample, rect: Rect) -> Result<Vec<u8>, String> {
    let caps = sample.caps().ok_or("a frame without caps")?;
    let info = VideoInfo::from_caps(caps).map_err(|_| "a frame of an unknown shape")?;
    let buffer = sample.buffer().ok_or("a frame without a buffer")?;
    let frame = VideoFrameRef::from_buffer_ref_readable(buffer, &info)
        .map_err(|_| "a frame could not be read")?;
    let luma = frame.plane_data(0).map_err(|_| "a frame has no luma")?;
    let stride = info.stride()[0] as usize;
    Ok(luma_crop(luma, stride, info.width(), info.height(), rect))
}

/// `rect` of a one-byte-per-pixel plane, clamped, as grey RGBA after a header
/// of the clamped width and height.
fn luma_crop(plane: &[u8], stride: usize, width: u32, height: u32, rect: Rect) -> Vec<u8> {
    let x = rect.x.min(width);
    let y = rect.y.min(height);
    let w = rect.width.min(width - x);
    let h = rect.height.min(height - y);
    let mut out = Vec::with_capacity(8 + (w * h * 4) as usize);
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    for row in y..y + h {
        let start = row as usize * stride + x as usize;
        for &value in &plane[start..start + w as usize] {
            out.extend_from_slice(&[value, value, value, 255]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_crop_is_clamped_grey_and_sized_up_front() {
        // A 4×3 plane with a stride of 6 (two bytes of row padding).
        let plane: Vec<u8> = (0..18).collect();
        let out = luma_crop(
            &plane,
            6,
            4,
            3,
            Rect {
                x: 2,
                y: 1,
                width: 10,
                height: 10,
            },
        );

        assert_eq!(&out[..8], &[2, 0, 0, 0, 2, 0, 0, 0]);
        assert_eq!(
            &out[8..],
            &[8, 8, 8, 255, 9, 9, 9, 255, 14, 14, 14, 255, 15, 15, 15, 255]
        );
    }

    #[test]
    fn ids_are_names_and_never_paths() {
        let handle = MediaHandle::new(&std::env::temp_dir().join("sapling-media-ids"));
        assert!(handle.path_of("3f2a-b1_c").is_ok());
        for bad in ["", "../x", "a/b", ".", &"x".repeat(65)] {
            assert!(handle.path_of(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn chunks_must_arrive_in_order_and_release_removes_the_file() {
        let root = std::env::temp_dir().join(format!("sapling-media-stage-{}", std::process::id()));
        let handle = MediaHandle::new(&root);

        handle.stage("a", 0, b"abc").unwrap();
        handle.stage("a", 3, b"de").unwrap();
        assert!(handle.stage("a", 9, b"x").is_err(), "a gap");
        assert_eq!(fs::read(handle.path_of("a").unwrap()).unwrap(), b"abcde");
        handle.stage("a", 0, b"z").unwrap();
        assert_eq!(fs::read(handle.path_of("a").unwrap()).unwrap(), b"z");

        handle.release("a");
        assert!(!handle.path_of("a").unwrap().exists());
        assert!(handle.probe("a").unwrap_err().contains("not staged"));
        let _ = fs::remove_dir_all(&root);
    }
}
