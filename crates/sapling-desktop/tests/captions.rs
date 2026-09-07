//! yt-dlp, for real.
//!
//! What `captions.rs`'s own tests cover is the part that is pure: the argument
//! vectors, and how a `--dump-single-json` document becomes a track list. What
//! they cannot cover is the whole point of the module — that a program called
//! `yt-dlp` is findable, that it still answers about a YouTube video, and that
//! the file it writes is `json3` the window can parse.
//!
//! So this file **skips itself** when yt-dlp is not on PATH and says so, the
//! same contract `voice.rs` and `dictation.rs` have without a model: a checkout
//! with no yt-dlp is normal, and `pnpm desktop:check` must be green in it.
//!
//! The one test that reaches YouTube is `#[ignore]`d as well, for the reason the
//! audible clip in `playback.rs` is: running the check should not be an event
//! outside this machine. yt-dlp against a live video is a network fetch and a
//! third party's rate limit, and a suite that made one on every run would be
//! red for reasons that have nothing to do with this code. Run it by hand when
//! the question is whether captions still come back:
//!
//! ```sh
//! nix develop .#desktop -c cargo test -p sapling-desktop --test captions -- --ignored --nocapture
//! ```
//!
//! The whole file is desktop-only, because the module it tests is: there is no
//! yt-dlp on a phone and `captions` is not compiled there at all.

#![cfg(desktop)]

use sapling_desktop::captions;

/// A video with both a written and an automatic track, used only by the
/// `#[ignore]`d test. If it ever goes away, any public video with captions does
/// — nothing about the assertions is about this one.
const VIDEO: &str = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/// Whether there is a yt-dlp to test at all, printing why not.
fn ytdlp_here() -> bool {
    match captions::status().ytdlp {
        Some(version) => {
            println!("yt-dlp {version}");
            true
        }
        None => {
            println!("skipped: yt-dlp is not on PATH (`nix develop .#desktop` provides it)");
            false
        }
    }
}

/// Runs on every machine, and asserts what is true on both kinds of them: the
/// probe answers rather than failing, and a version it reports is a version and
/// not an empty line.
#[test]
fn the_probe_answers_for_whichever_tools_this_machine_has() {
    let status = captions::status();

    for (name, version) in [("yt-dlp", &status.ytdlp), ("deno", &status.deno)] {
        match version {
            Some(version) => {
                assert!(
                    !version.trim().is_empty(),
                    "{name} reported a blank version"
                );
                assert_eq!(
                    version.lines().count(),
                    1,
                    "{name}: one line, not the banner"
                );
            }
            None => println!("{name} is not on PATH"),
        }
    }
}

/// A URL that is not a video is a failure the composer can show, not a panic
/// and not a hang. Cheap enough to run on every machine that has yt-dlp,
/// because yt-dlp refuses it without asking YouTube anything.
#[test]
fn something_that_is_not_a_video_comes_back_as_a_message() {
    if !ytdlp_here() {
        return;
    }

    let refused = captions::list("not-a-url-at-all").expect_err("yt-dlp refuses this");
    println!("{refused}");
    assert!(refused.starts_with("yt-dlp could not read that video"));
}

/// The real thing, end to end: list a video's tracks, fetch one, and check that
/// what comes back is the `json3` the window's parser expects.
#[test]
#[ignore = "reaches YouTube; run by hand"]
fn lists_and_fetches_a_real_video() {
    if !ytdlp_here() {
        return;
    }

    let listing = captions::list(VIDEO).expect("yt-dlp describes the video");
    println!("{} — {} tracks", listing.title, listing.tracks.len());
    assert_eq!(listing.id.len(), 11, "a YouTube id is eleven characters");
    assert!(!listing.title.is_empty());
    assert!(
        !listing.tracks.is_empty(),
        "this video is supposed to have captions"
    );
    // Manual before automatic, which is the order the composer offers.
    let first_auto = listing.tracks.iter().position(|track| track.auto);
    let last_manual = listing.tracks.iter().rposition(|track| !track.auto);
    if let (Some(first_auto), Some(last_manual)) = (first_auto, last_manual) {
        assert!(last_manual < first_auto);
    }
    // The explosion of machine translations is filtered out, so this is a
    // list a person can look at.
    assert!(
        listing.tracks.len() < 20,
        "{} tracks means the `tlang=` filter has stopped working",
        listing.tracks.len()
    );

    let track = &listing.tracks[0];
    let app_data = std::env::temp_dir().join(format!("sapling-captions-{}", std::process::id()));
    let text = captions::fetch(&app_data, VIDEO, &track.lang, track.auto)
        .expect("yt-dlp writes the track");

    println!("{} ({}): {} bytes", track.name, track.lang, text.len());
    // Not parsed here — that is `src/lib/reading/subtitles.ts`'s job, and this
    // only checks that what crossed is the shape it reads.
    assert!(text.contains("\"events\""), "json3 carries an events array");
    assert!(text.contains("tStartMs"), "and its events carry offsets");

    // The staging directory is removed whether the fetch worked or not, so
    // nothing is left under the app-data directory afterwards.
    assert!(
        !app_data.join("captions.partial").exists(),
        "the staging directory outlived the fetch"
    );
    let _ = std::fs::remove_dir_all(&app_data);
}
