//! The real GStreamer over a small Matroska file it writes itself (raw video
//! and raw audio, so no encoder plugin is needed). Skips with a reason where
//! GStreamer or its base plugins are missing.

use std::fs;
use std::path::Path;

use gstreamer as gst;
use gstreamer::prelude::*;
use sapling_media::{MediaHandle, Rect, SAMPLE_RATE};

/// Two seconds of a white 64×48 picture and a 440 Hz tone.
fn write_fixture(path: &Path) -> Result<(), String> {
    gst::init().map_err(|e| e.to_string())?;
    let description = format!(
        "videotestsrc num-buffers=60 pattern=white ! video/x-raw,format=I420,width=64,height=48,framerate=30/1 ! queue ! mux. \
         audiotestsrc num-buffers=20 samplesperbuffer=4800 wave=sine freq=440 ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! queue ! mux. \
         matroskamux name=mux ! filesink location={}",
        path.display()
    );
    let pipeline = gst::parse::launch(&description).map_err(|e| e.to_string())?;
    pipeline
        .set_state(gst::State::Playing)
        .map_err(|e| e.to_string())?;
    let bus = pipeline.bus().ok_or("no bus")?;
    let done = bus.timed_pop_filtered(
        gst::ClockTime::from_seconds(20),
        &[gst::MessageType::Eos, gst::MessageType::Error],
    );
    let _ = pipeline.set_state(gst::State::Null);
    match done.as_ref().map(|m| m.view()) {
        Some(gst::MessageView::Eos(_)) => Ok(()),
        other => Err(format!("{other:?}")),
    }
}

#[test]
fn reads_length_sound_and_pictures_from_a_staged_file() {
    let root = std::env::temp_dir().join(format!("sapling-media-decode-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("fixture.mkv");
    if let Err(why) = write_fixture(&source) {
        eprintln!("skipping: GStreamer could not write a test file here ({why})");
        return;
    }
    let bytes = fs::read(&source).unwrap();
    let handle = MediaHandle::new(&root.join("cache"));
    let (head, tail) = bytes.split_at(bytes.len() / 2);
    handle.stage("clip", 0, head).unwrap();
    handle.stage("clip", head.len() as u64, tail).unwrap();

    let info = handle.probe("clip").unwrap();
    assert_eq!((info.width, info.height), (64, 48));
    assert!(info.audio);
    assert!((info.duration_ms - 2000.0).abs() < 100.0, "{info:?}");

    let pcm = handle.audio("clip", 500.0, 1500.0).unwrap();
    let samples = pcm.len() / 2;
    assert!(
        (samples as i64 - SAMPLE_RATE as i64).abs() < 400,
        "one second at 16 kHz: {samples}"
    );
    let loud = pcm
        .chunks_exact(2)
        .map(|p| i16::from_le_bytes([p[0], p[1]]).unsigned_abs() as u64)
        .max()
        .unwrap();
    assert!(loud > 5000, "the tone came through: {loud}");

    let rect = Rect {
        x: 8,
        y: 30,
        width: 48,
        height: 100,
    };
    for at in [1200.0, 1500.0, 300.0] {
        let frame = handle.frame("clip", at, rect).unwrap();
        let w = u32::from_le_bytes(frame[0..4].try_into().unwrap());
        let h = u32::from_le_bytes(frame[4..8].try_into().unwrap());
        assert_eq!((w, h), (48, 18), "clamped to the picture");
        assert_eq!(frame.len(), 8 + (w * h * 4) as usize);
        assert!(frame[8..]
            .chunks_exact(4)
            .all(|px| px[0] > 200 && px[3] == 255));
    }

    handle.release("clip");
    assert!(handle.probe("clip").is_err());
    let _ = fs::remove_dir_all(&root);
}
