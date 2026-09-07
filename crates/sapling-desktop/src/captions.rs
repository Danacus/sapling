//! A video's caption tracks, through yt-dlp — the third capability this host
//! lends, and the smallest.
//!
//! The learner's route to a reading text is usually a video, and the subtitle
//! file is the one artefact of it a *browser* cannot get: YouTube's timedtext
//! endpoints send no CORS headers and the IFrame API exposes no track list, so
//! a page can never turn a link into a transcript however hard it tries
//! (`docs/reading-mode.md` §7). A host that can run a program can, and this is
//! that — the app asks, yt-dlp answers, and what comes back goes into exactly
//! the import path the subtitle-file picker already feeds.
//!
//! It passes the same test persistence and speech pass: a platform primitive
//! with no domain knowledge in it. A URL in and a caption file out. **The host
//! does not parse captions** — `captions_fetch` hands back yt-dlp's `json3`
//! bytes verbatim, because parsing them is `src/lib/reading/subtitles.ts`'s
//! job, where the SRT and VTT parsers already live and are tested, and a second
//! implementation here would be the kind of thing that silently disagrees with
//! the first.
//!
//! ## yt-dlp comes from PATH, and is deliberately not pinned
//!
//! `src/models.rs` pins a URL, an exact byte count and a sha256 for every
//! model, and that is right for a model: those bytes are a constant and a
//! different set of them is a different voice. yt-dlp is the opposite kind of
//! dependency. YouTube changes its player and its signature scheme every few
//! weeks, yt-dlp's answer is a release within days, and the fix a learner needs
//! is always "update yt-dlp" — so a pinned binary here would be a pinned
//! *breakage*, aging out on a schedule nobody controls. It is found on PATH or
//! it is not, and [`status`] is how the window says which so the composer can
//! name the program rather than fail mysteriously.
//!
//! **Deno is the same shape of fact one step further out.** Since late 2025
//! yt-dlp needs an external JavaScript runtime — Deno by default — for full
//! YouTube extraction; without one it warns and may drop formats. Captions
//! usually survive that, so this is reported rather than required: [`status`]
//! answers for both programs and the window says which one is missing.
//!
//! ## No new dependency, and nothing here is a plugin
//!
//! `std::process::Command` and the `serde_json` that was already in the
//! manifest. Not `tauri-plugin-shell`: there is nothing to configure and no
//! allowlist worth maintaining for three fixed argument vectors, and a plugin
//! would put a scope file between this module and the one program it runs.
//!
//! ## Android never meets any of this
//!
//! The whole module and its three commands are `#[cfg(desktop)]` — Tauri's own
//! cfg alias, the one `tts_play` uses. There is no yt-dlp on a phone and no
//! PATH to find one on, so this is not a *feature* (there is nothing to link)
//! but a target gate, and its purpose is that Android's compiler never sees the
//! code at all. That is not a hole in what a phone can read: a text imported on
//! the desktop is an event like any other, so it syncs to every paired device
//! and the phone opens it as an ordinary text.
//!
//! ## Argument vectors are pure functions, because they are the contract
//!
//! What can be wrong here is which flags yt-dlp is handed and how the listing
//! JSON is read, so both are pure and unit-tested below; what cannot be tested
//! without the program is the running of it, and `tests/captions.rs` skips
//! itself when yt-dlp is absent exactly as the speech tests skip without a
//! model.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

/// The program that does all the work. Found on PATH or not at all.
const YTDLP: &str = "yt-dlp";

/// The JavaScript runtime yt-dlp wants for full YouTube extraction. Reported,
/// never required — see the module header.
const DENO: &str = "deno";

/// The one subtitle format asked for and the only one the window can parse.
///
/// Every YouTube track has a `json3` rendering, it carries millisecond offsets
/// rather than formatted timestamps, and it has no rolling-window repetition to
/// undo — so it is both the most available format and the easiest one to read.
const SUB_FORMAT: &str = "json3";

/// Where a fetch assembles the track before it is read, under the app-data
/// directory.
///
/// The same `.partial` idea `models.rs` uses and for a smaller version of the
/// same reason: a run that crashes or is killed leaves files behind, and they
/// have to be findable by the next run rather than accumulating under names
/// nobody remembers. One fixed name, swept before use and removed after, so the
/// directory exists only while yt-dlp is writing into it.
const STAGING_DIR: &str = "captions.partial";

/// How many lines of yt-dlp's stderr reach the learner when it fails.
///
/// The last ones, because yt-dlp says what it was doing first and what went
/// wrong last. Three is enough for its `ERROR:` line plus whatever context it
/// put above it, and short enough to sit in a task-tray row.
const STDERR_LINES: usize = 3;

/// Which of the two programs this machine has, and at what version.
///
/// Serialized camelCase for the TypeScript that reads it; the field names are
/// `src/lib/media/captions.ts`'s `CaptionsTools`. `None` means "not on PATH" —
/// the one thing the window needs to know to decide whether to offer the
/// action at all.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsStatus {
    pub ytdlp: Option<String>,
    pub deno: Option<String>,
}

/// One caption track a video carries.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTrack {
    /// The language code yt-dlp names it by, which is also what `--sub-langs`
    /// takes back.
    pub lang: String,
    /// What to call it on screen — yt-dlp's own name for the track where it has
    /// one, and the language code where it does not.
    pub name: String,
    /// Machine-generated rather than written by a person. Decides which of
    /// `--write-subs` / `--write-auto-subs` fetches it, and is worth a mark in
    /// the list because the quality difference is large.
    pub auto: bool,
}

/// What a video turned out to have.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsListing {
    pub id: String,
    pub title: String,
    /// Manual tracks first, then the automatic ones.
    pub tracks: Vec<CaptionTrack>,
}

/// Whether yt-dlp and Deno are on this machine's PATH.
///
/// Cheap on purpose — two `--version` calls, no lock, no network — because the
/// composer asks it on every visit to decide whether the action exists.
pub fn status() -> CaptionsStatus {
    CaptionsStatus {
        ytdlp: version_of(YTDLP),
        deno: version_of(DENO),
    }
}

/// A program's first line of `--version`, or `None` when it is not there.
///
/// The first line and not the whole output: `yt-dlp --version` prints one line,
/// `deno --version` prints three (itself, V8, TypeScript) and only the first is
/// about the program that was asked.
fn version_of(program: &str) -> Option<String> {
    let output = Command::new(program).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_owned)
}

/// Every caption track `url` has, with the manual ones first.
pub fn list(url: &str) -> Result<CaptionsListing, String> {
    parse_listing(&run(&list_args(url))?)
}

/// One track, as yt-dlp wrote it — raw `json3`, unparsed.
///
/// `app_data` is Tauri's per-app directory, which is the only writable place
/// this host is sure of; the track lands in a swept `.partial` sibling under it
/// and the directory is removed again whether the fetch worked or not, so
/// nothing accumulates and no half-written file is ever read.
pub fn fetch(app_data: &Path, url: &str, lang: &str, auto: bool) -> Result<String, String> {
    let staging = staging_in(app_data);
    // Whatever a killed run left behind. Never reused: a track that was being
    // written when the process died is exactly the file that must not be
    // mistaken for this fetch's answer.
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|cause| format!("could not create {}: {cause}", staging.display()))?;

    let fetched = run(&fetch_args(url, lang, auto, &template_in(&staging)))
        .and_then(|_| read_track(&staging));

    let _ = fs::remove_dir_all(&staging);
    fetched
}

/// The staging directory under an app-data directory.
fn staging_in(app_data: &Path) -> PathBuf {
    app_data.join(STAGING_DIR)
}

/// What `-o` is given.
///
/// yt-dlp builds a subtitle's filename by substituting `<lang>.<format>` for
/// `%(ext)s`, so this template produces `captions.<lang>.json3` and the
/// directory holds exactly one file whose name this side does not have to
/// predict — [`read_track`] finds it by extension instead, which is the only
/// thing about the name that is fixed.
fn template_in(staging: &Path) -> PathBuf {
    staging.join("captions.%(ext)s")
}

/// What yt-dlp is asked for a listing: this one video, described, downloaded
/// not at all.
fn list_args(url: &str) -> Vec<String> {
    vec![
        // One JSON document describing the video, `subtitles` and
        // `automatic_captions` included.
        "--dump-single-json".to_owned(),
        "--skip-download".to_owned(),
        // A link the learner copied out of a playlist would otherwise describe
        // every video in it.
        "--no-playlist".to_owned(),
        // The document goes to stdout and is parsed; a warning on stdout would
        // be a parse error.
        "--no-warnings".to_owned(),
        url.to_owned(),
    ]
}

/// What yt-dlp is asked for one track: that language, that origin, `json3`,
/// into `template`.
fn fetch_args(url: &str, lang: &str, auto: bool, template: &Path) -> Vec<String> {
    vec![
        "--skip-download".to_owned(),
        "--no-playlist".to_owned(),
        "--no-warnings".to_owned(),
        "--sub-format".to_owned(),
        SUB_FORMAT.to_owned(),
        "--sub-langs".to_owned(),
        lang.to_owned(),
        // The two are separate switches upstream, and only one is wanted: asking
        // for both would fetch a manual track when an automatic one was picked,
        // which is a different transcript under the name the learner chose.
        if auto {
            "--write-auto-subs".to_owned()
        } else {
            "--write-subs".to_owned()
        },
        "-o".to_owned(),
        template.to_string_lossy().into_owned(),
        url.to_owned(),
    ]
}

/// Runs yt-dlp and hands back its stdout.
///
/// The two failures a learner can act on are told apart: a program that is not
/// installed, and a program that ran and refused. The second carries yt-dlp's
/// own last words, because "could not fetch those captions" on its own is not
/// something anyone can do anything about — a private video, a region block and
/// a signature scheme yt-dlp has not caught up with all look the same from
/// here, and yt-dlp says which.
fn run(args: &[String]) -> Result<String, String> {
    let output = Command::new(YTDLP)
        .args(args)
        .output()
        .map_err(|cause| match cause.kind() {
            std::io::ErrorKind::NotFound => {
                format!("{YTDLP} is not on this machine's PATH")
            }
            _ => format!("{YTDLP} could not be run: {cause}"),
        })?;

    if !output.status.success() {
        return Err(format!(
            "{YTDLP} could not read that video: {}",
            last_lines(&String::from_utf8_lossy(&output.stderr))
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// yt-dlp's last few words, blank lines dropped.
fn last_lines(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.is_empty() {
        return "it said nothing".to_owned();
    }
    lines[lines.len().saturating_sub(STDERR_LINES)..].join(" · ")
}

/// The one `json3` file in the staging directory.
///
/// Found by extension rather than by name: the language part of the filename is
/// yt-dlp's to choose (it may normalize the code that was asked for), and the
/// directory was created empty a moment ago, so anything with that extension in
/// it is this fetch's answer.
fn read_track(staging: &Path) -> Result<String, String> {
    let entries = fs::read_dir(staging)
        .map_err(|cause| format!("could not read {}: {cause}", staging.display()))?;

    let track = entries
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some(SUB_FORMAT))
        .ok_or_else(|| format!("{YTDLP} wrote no {SUB_FORMAT} track for that language"))?;

    fs::read_to_string(&track).map_err(|cause| format!("could not read the track: {cause}"))
}

/// The tracks out of a `--dump-single-json` document.
///
/// Pure, and separate from [`run`] for that reason: what can be wrong about a
/// listing is how the two caption maps are read, and that is testable without
/// yt-dlp or a network.
fn parse_listing(json: &str) -> Result<CaptionsListing, String> {
    let root: Value = serde_json::from_str(json)
        .map_err(|cause| format!("{YTDLP} answered something that is not JSON: {cause}"))?;

    let id = root
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{YTDLP} described no video"))?;
    // A video with no title is not a failure — the id is a usable name and the
    // learner can see which link they pasted.
    let title = root.get("title").and_then(Value::as_str).unwrap_or(id);

    // Manual first, deliberately: a track a person wrote is punctuated, and
    // punctuation is what lets `cuesToSentences` cut the transcript into
    // sentences instead of falling back to one sentence per cue.
    let mut tracks = tracks_from(root.get("subtitles"), false);
    tracks.extend(tracks_from(root.get("automatic_captions"), true));

    Ok(CaptionsListing {
        id: id.to_owned(),
        title: title.to_owned(),
        tracks,
    })
}

/// One of the two caption maps as a track list.
///
/// A map entry is a language code against the formats that language is
/// available in, and only `json3` is of any use here — so an entry with no
/// `json3` rendering is dropped rather than offered and then failing at the
/// fetch. In practice every YouTube track has one.
fn tracks_from(map: Option<&Value>, auto: bool) -> Vec<CaptionTrack> {
    let Some(Value::Object(languages)) = map else {
        return Vec::new();
    };

    languages
        .iter()
        .filter_map(|(lang, formats)| {
            let json3 = formats
                .as_array()?
                .iter()
                .find(|format| format.get("ext").and_then(Value::as_str) == Some(SUB_FORMAT))?;
            if auto && is_translation(json3) {
                return None;
            }
            let name = json3
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(lang);
            Some(CaptionTrack {
                lang: lang.clone(),
                name: name.to_owned(),
                auto,
            })
        })
        .collect()
}

/// Whether an automatic track is a machine *translation* of the recognized one
/// rather than the recognized one itself.
///
/// This is the difference between offering two automatic tracks and offering
/// two hundred: YouTube will translate its own speech recognition into every
/// language it knows, and yt-dlp lists all of them under
/// `automatic_captions`. A translation of a transcription is not a text worth
/// reading in the language being learnt, and a list nobody can scroll is worse
/// than no list. The signal is YouTube's own `tlang` query parameter — the
/// translation target — which is on every translated URL and on no original.
fn is_translation(format: &Value) -> bool {
    format
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(|url| url.contains("tlang="))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `--dump-single-json` document cut down to the parts this module reads:
    /// a manual Japanese track, the recognized Japanese one, a machine
    /// translation of it, and a language available in no useful format.
    const LISTING: &str = r#"{
        "id": "abcdefghijk",
        "title": "A morning at the market",
        "subtitles": {
            "ja": [
                { "ext": "vtt", "url": "https://example.test/ja.vtt", "name": "Japanese" },
                { "ext": "json3", "url": "https://example.test/ja.json3", "name": "Japanese" }
            ],
            "de": [
                { "ext": "vtt", "url": "https://example.test/de.vtt", "name": "German" }
            ]
        },
        "automatic_captions": {
            "ja": [
                { "ext": "json3", "url": "https://example.test/auto.json3", "name": "Japanese" }
            ],
            "en": [
                {
                    "ext": "json3",
                    "url": "https://example.test/auto.json3&tlang=en",
                    "name": "English from Japanese"
                }
            ],
            "nl": [
                { "ext": "json3", "url": "https://example.test/auto.json3" }
            ]
        }
    }"#;

    #[test]
    fn a_listing_names_the_video_and_puts_the_manual_tracks_first() {
        let listing = parse_listing(LISTING).unwrap();

        assert_eq!(listing.id, "abcdefghijk");
        assert_eq!(listing.title, "A morning at the market");
        assert_eq!(
            listing.tracks,
            vec![
                CaptionTrack {
                    lang: "ja".to_owned(),
                    name: "Japanese".to_owned(),
                    auto: false,
                },
                CaptionTrack {
                    lang: "ja".to_owned(),
                    name: "Japanese".to_owned(),
                    auto: true,
                },
                // No `name` in the document, so the code stands in for one.
                CaptionTrack {
                    lang: "nl".to_owned(),
                    name: "nl".to_owned(),
                    auto: true,
                },
            ]
        );
    }

    #[test]
    fn a_language_with_no_json3_rendering_is_not_offered() {
        let listing = parse_listing(LISTING).unwrap();
        assert!(
            !listing.tracks.iter().any(|track| track.lang == "de"),
            "German is vtt-only here, and vtt is not what the window parses"
        );
    }

    #[test]
    fn the_machine_translations_are_dropped_and_the_recognized_track_is_not() {
        let listing = parse_listing(LISTING).unwrap();
        assert!(
            !listing.tracks.iter().any(|track| track.lang == "en"),
            "`tlang=` marks a translation of the Japanese recognition"
        );
        assert!(listing.tracks.iter().any(|track| track.lang == "ja" && track.auto));
    }

    #[test]
    fn a_video_with_no_captions_at_all_is_an_empty_list_and_not_an_error() {
        let listing = parse_listing(r#"{ "id": "x", "title": "Silent" }"#).unwrap();
        assert!(listing.tracks.is_empty());
    }

    #[test]
    fn anything_that_is_not_a_video_document_is_an_error() {
        assert!(parse_listing("not json at all").is_err());
        assert!(parse_listing(r#"{ "title": "no id" }"#).is_err());
    }

    #[test]
    fn a_listing_asks_about_one_video_and_downloads_nothing() {
        let args = list_args("https://www.youtube.com/watch?v=abcdefghijk");

        assert!(args.contains(&"--dump-single-json".to_owned()));
        assert!(args.contains(&"--skip-download".to_owned()));
        assert!(args.contains(&"--no-playlist".to_owned()));
        assert!(args.contains(&"--no-warnings".to_owned()));
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://www.youtube.com/watch?v=abcdefghijk"),
            "the URL is the positional argument and goes last"
        );
    }

    #[test]
    fn a_fetch_asks_for_json3_of_exactly_the_track_that_was_picked() {
        let staging = staging_in(Path::new("/tmp/sapling"));
        let template = template_in(&staging);

        let manual = fetch_args("https://youtu.be/x", "ja", false, &template);
        assert!(manual.contains(&"--write-subs".to_owned()));
        assert!(!manual.contains(&"--write-auto-subs".to_owned()));

        let automatic = fetch_args("https://youtu.be/x", "ja", true, &template);
        assert!(automatic.contains(&"--write-auto-subs".to_owned()));
        assert!(!automatic.contains(&"--write-subs".to_owned()));

        // The format and the language travel as a flag and its value, in that
        // order — a pair that came apart would fetch every language.
        for args in [&manual, &automatic] {
            let format = args.iter().position(|arg| arg == "--sub-format").unwrap();
            assert_eq!(args[format + 1], SUB_FORMAT);
            let langs = args.iter().position(|arg| arg == "--sub-langs").unwrap();
            assert_eq!(args[langs + 1], "ja");
            let out = args.iter().position(|arg| arg == "-o").unwrap();
            assert_eq!(args[out + 1], template.to_string_lossy());
            assert!(args.contains(&"--skip-download".to_owned()));
        }
    }

    #[test]
    fn the_staging_directory_is_swept_by_name_and_writes_one_predictable_file() {
        let staging = staging_in(Path::new("/tmp/sapling"));
        assert_eq!(staging, Path::new("/tmp/sapling/captions.partial"));
        // `%(ext)s` becomes `<lang>.json3`, so the file lands inside the
        // directory and nowhere else — which is what makes `read_track`'s
        // find-by-extension exact.
        assert_eq!(
            template_in(&staging),
            Path::new("/tmp/sapling/captions.partial/captions.%(ext)s")
        );
    }

    #[test]
    fn a_failure_carries_yt_dlps_own_last_words() {
        let said = last_lines(
            "[youtube] Extracting URL: https://youtu.be/abcdefghijk\n\
             [youtube] abcdefghijk: Downloading webpage\n\n\
             WARNING: something\n\
             ERROR: Private video. Sign in if you've been granted access\n",
        );
        // yt-dlp narrates first and explains itself last, so the tail is the
        // half worth showing.
        assert!(said.contains("Private video"), "{said}");
        assert!(!said.contains("Extracting URL"), "only the last few: {said}");
        assert_eq!(last_lines("   \n\n"), "it said nothing");
    }
}
