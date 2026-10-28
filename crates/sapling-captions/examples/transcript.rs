//! `cargo run -p sapling-captions --example transcript -- <video_id> [lang] [--auto]`
//!
//! Lists a video's caption tracks and prints the first cues of one, over ureq.
//! `SAPLING_YT_HEADERS="Origin: https://example.org|Cookie: a=b"` adds headers
//! to every request, to see what a relay may send without breaking it.

use std::env;

use pollster::block_on;
use sapling_captions::innertube::{self, Method, Request, Response, Transport};

struct Ureq {
    agent: ureq::Agent,
    extra: Vec<(String, String)>,
}

impl Transport for Ureq {
    async fn send(&self, request: Request) -> Result<Response, String> {
        let headers = request.headers.iter().chain(&self.extra);
        let result = match request.method {
            Method::Get => {
                let mut call = self.agent.get(&request.url);
                for (name, value) in headers {
                    call = call.header(name, value);
                }
                call.call()
            }
            Method::Post => {
                let mut call = self.agent.post(&request.url);
                for (name, value) in headers {
                    call = call.header(name, value);
                }
                call.send(request.body.unwrap_or_default())
            }
        };
        let mut response = result.map_err(|cause| cause.to_string())?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(32 * 1024 * 1024)
            .read_to_string()
            .map_err(|cause| cause.to_string())?;
        eprintln!(
            "  {} {} -> {status}, {} bytes",
            match request.method {
                Method::Get => "GET",
                Method::Post => "POST",
            },
            request.url.split('?').next().unwrap_or_default(),
            body.len()
        );
        Ok(Response { status, body })
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let auto = args.iter().any(|arg| arg == "--auto");
    let mut positional = args.iter().filter(|arg| !arg.starts_with("--"));
    let Some(video_id) = positional.next() else {
        eprintln!("usage: transcript <video_id> [lang] [--auto]");
        std::process::exit(2);
    };
    let lang = positional.next();

    let extra = env::var("SAPLING_YT_HEADERS")
        .unwrap_or_default()
        .split('|')
        .filter_map(|pair| pair.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect();
    let transport = Ureq {
        // A 4xx is an answer to report, not a transport failure.
        agent: ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into(),
        extra,
    };

    let listing = match block_on(innertube::list_tracks(&transport, video_id)) {
        Ok(listing) => listing,
        Err(error) => {
            eprintln!("list failed: {error}");
            std::process::exit(1);
        }
    };
    println!("{} — {}", listing.id, listing.title);
    for track in &listing.tracks {
        println!(
            "  {:8} {}{}",
            track.lang,
            track.name,
            if track.auto { " [auto]" } else { "" }
        );
    }

    let track = listing
        .tracks
        .iter()
        .filter(|track| lang.is_none_or(|lang| &track.lang == lang))
        .find(|track| !auto || track.auto)
        .or_else(|| listing.tracks.first());
    let Some(track) = track else {
        println!("no tracks");
        return;
    };
    println!("fetching {} (auto: {})", track.lang, track.auto);
    match block_on(innertube::fetch_track(&transport, video_id, track)) {
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
