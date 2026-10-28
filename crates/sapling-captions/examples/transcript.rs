//! `cargo run -p sapling-captions --features native --example transcript -- <video_id> [lang] [--auto]`
//!
//! Lists a video's caption tracks and prints the first cues of one, live — the
//! check for whether YouTube still answers the way `innertube` expects.

use std::env;

use sapling_captions::native;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let auto = args.iter().any(|arg| arg == "--auto");
    let mut positional = args.iter().filter(|arg| !arg.starts_with("--"));
    let Some(video_id) = positional.next() else {
        eprintln!("usage: transcript <video_id> [lang] [--auto]");
        std::process::exit(2);
    };
    let lang = positional.next();

    let listing = native::list(video_id).unwrap_or_else(|error| {
        eprintln!("list failed: {error}");
        std::process::exit(1);
    });
    println!("{} — {}", listing.id, listing.title);
    for track in &listing.tracks {
        let mark = if track.auto { " [auto]" } else { "" };
        println!("  {:8} {}{mark}", track.lang, track.name);
    }

    let Some(track) = listing
        .tracks
        .iter()
        .filter(|track| lang.is_none_or(|lang| &track.lang == lang))
        .find(|track| !auto || track.auto)
        .or_else(|| listing.tracks.first())
    else {
        println!("no tracks");
        return;
    };
    println!("fetching {} (auto: {})", track.lang, track.auto);
    match native::fetch(video_id, track) {
        Ok(json3) => {
            let imported = sapling_import::import_source(&json3);
            println!(
                "{} bytes of json3, {} segments",
                json3.len(),
                imported.segments.len()
            );
            for segment in imported.segments.iter().take(5) {
                println!("  {}", segment.text);
            }
        }
        Err(error) => {
            eprintln!("fetch failed: {error}");
            std::process::exit(1);
        }
    }
}
