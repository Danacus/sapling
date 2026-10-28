//! A video's caption tracks straight from YouTube, over an injected HTTP
//! transport — no yt-dlp, no process, no HTTP crate.
//!
//! One route works without a PO token: InnerTube's `player` endpoint asked as
//! the ANDROID client, whose caption `baseUrl`s are not in the `exp=xpe`
//! experiment that answers the WEB client's timedtext with an empty body. The
//! same `baseUrl` with `fmt=json3` is the file yt-dlp writes, so it goes to
//! `sapling-import` unchanged. The WEB transcript panel (`get_transcript`)
//! answers `FAILED_PRECONDITION` to a client that is not a real browser session.
//!
//! The transport is the host's, as in `sapling-sync`: native here through an
//! example over ureq, a browser-extension relay later.

use std::future::Future;

use serde_json::{json, Value};

use crate::{CaptionTrack, CaptionsListing};

const PLAYER_URL: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const CLIENT_NAME: &str = "ANDROID";
const CLIENT_VERSION: &str = "20.10.38";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

/// One HTTP request. `Err` is a failure to get any response at all.
pub trait Transport {
    fn send(&self, request: Request) -> impl Future<Output = Result<Response, String>>;
}

/// Every caption track the video has, manual first.
pub async fn list_tracks<T: Transport>(
    transport: &T,
    video_id: &str,
) -> Result<CaptionsListing, String> {
    let player = parse_player(&send_ok(transport, player_request(video_id)).await?)?;
    Ok(player.listing(video_id))
}

/// One track as `json3` text. The player is asked again because a `baseUrl`
/// is signed and expires.
pub async fn fetch_track<T: Transport>(
    transport: &T,
    video_id: &str,
    track: &CaptionTrack,
) -> Result<String, String> {
    let player = parse_player(&send_ok(transport, player_request(video_id)).await?)?;
    let url = player
        .tracks
        .iter()
        .find(|t| t.track.lang == track.lang && t.track.auto == track.auto)
        .map(|t| json3_url(&t.base_url))
        .ok_or_else(|| format!("the video has no {} track", track.lang))?;
    let body = send_ok(
        transport,
        Request {
            method: Method::Get,
            url,
            headers: Vec::new(),
            body: None,
        },
    )
    .await?;
    // YouTube's answer to a URL that wanted a PO token is a 200 with nothing.
    if body.trim().is_empty() {
        return Err("YouTube sent an empty track (it wants a PO token)".to_owned());
    }
    Ok(body)
}

async fn send_ok<T: Transport>(transport: &T, request: Request) -> Result<String, String> {
    let url = request.url.clone();
    let response = transport.send(request).await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("{url} answered {}", response.status));
    }
    Ok(response.body)
}

/// The `player` call. No API key, cookie or User-Agent is needed.
pub fn player_request(video_id: &str) -> Request {
    let body = json!({
        "context": { "client": {
            "clientName": CLIENT_NAME,
            "clientVersion": CLIENT_VERSION,
            "hl": "en",
        }},
        "videoId": video_id,
    });
    Request {
        method: Method::Post,
        url: PLAYER_URL.to_owned(),
        headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
        body: Some(body.to_string()),
    }
}

/// `baseUrl` with its `fmt` replaced by `json3`.
pub fn json3_url(base_url: &str) -> String {
    let (path, query) = base_url.split_once('?').unwrap_or((base_url, ""));
    let mut params: Vec<&str> = query
        .split('&')
        .filter(|p| !p.is_empty() && !p.starts_with("fmt="))
        .collect();
    params.push("fmt=json3");
    format!("{path}?{}", params.join("&"))
}

#[derive(Debug)]
struct PlayerTrack {
    track: CaptionTrack,
    base_url: String,
}

#[derive(Debug)]
struct Player {
    title: Option<String>,
    tracks: Vec<PlayerTrack>,
}

impl Player {
    fn listing(self, video_id: &str) -> CaptionsListing {
        CaptionsListing {
            id: video_id.to_owned(),
            title: self.title.unwrap_or_else(|| video_id.to_owned()),
            tracks: self.tracks.into_iter().map(|t| t.track).collect(),
        }
    }
}

fn parse_player(body: &str) -> Result<Player, String> {
    let root: Value = serde_json::from_str(body)
        .map_err(|cause| format!("the player answered something that is not JSON: {cause}"))?;

    let status = root["playabilityStatus"]["status"].as_str().unwrap_or("");
    if status != "OK" {
        let reason = root["playabilityStatus"]["reason"]
            .as_str()
            .unwrap_or("no reason given");
        return Err(format!(
            "YouTube will not play that video ({status}): {reason}"
        ));
    }

    let mut tracks: Vec<PlayerTrack> = root["captions"]["playerCaptionsTracklistRenderer"]
        ["captionTracks"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|t| {
            let lang = t["languageCode"].as_str()?;
            let base_url = t["baseUrl"].as_str()?;
            let name = t["name"]["simpleText"]
                .as_str()
                .or_else(|| t["name"]["runs"][0]["text"].as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(lang);
            Some(PlayerTrack {
                track: CaptionTrack {
                    lang: lang.to_owned(),
                    name: name.to_owned(),
                    auto: t["kind"].as_str() == Some("asr"),
                },
                base_url: base_url.to_owned(),
            })
        })
        .collect();
    tracks.sort_by_key(|t| t.track.auto);

    Ok(Player {
        title: root["videoDetails"]["title"].as_str().map(str::to_owned),
        tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    use pollster::block_on;

    const PLAYER: &str = include_str!("../fixtures/player.json");
    const TRACK: &str = include_str!("../fixtures/timedtext.json3");

    /// Answers the player with `PLAYER` and any timedtext URL with `track`.
    struct Fake {
        track: &'static str,
        seen: RefCell<Vec<Request>>,
    }

    impl Transport for Fake {
        async fn send(&self, request: Request) -> Result<Response, String> {
            let body = if request.url.starts_with(PLAYER_URL) {
                PLAYER
            } else {
                self.track
            };
            self.seen.borrow_mut().push(request);
            Ok(Response {
                status: 200,
                body: body.to_owned(),
            })
        }
    }

    fn fake(track: &'static str) -> Fake {
        Fake {
            track,
            seen: RefCell::default(),
        }
    }

    #[test]
    fn the_player_is_asked_as_the_android_client() {
        let request = player_request("02w8LwJCgQY");
        assert_eq!(request.method, Method::Post);
        let body: Value = serde_json::from_str(request.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["videoId"], "02w8LwJCgQY");
        assert_eq!(body["context"]["client"]["clientName"], "ANDROID");
    }

    #[test]
    fn a_listing_reads_both_name_shapes_and_puts_manual_tracks_first() {
        let listing = block_on(list_tracks(&fake(TRACK), "02w8LwJCgQY")).unwrap();
        assert_eq!(listing.title, "Vandaag wordt er gestemd in Israël");
        let tracks: Vec<(&str, &str, bool)> = listing
            .tracks
            .iter()
            .map(|t| (t.lang.as_str(), t.name.as_str(), t.auto))
            .collect();
        assert_eq!(
            tracks,
            vec![
                ("nl", "Dutch", false),
                ("de", "de", false),
                ("nl", "Dutch (auto-generated)", true),
            ]
        );
    }

    #[test]
    fn an_unplayable_video_is_an_error_with_youtubes_reason() {
        let error = parse_player(
            r#"{"playabilityStatus":{"status":"ERROR","reason":"Video unavailable"}}"#,
        )
        .unwrap_err();
        assert!(error.contains("Video unavailable"), "{error}");
    }

    #[test]
    fn a_video_without_captions_lists_nothing() {
        let player = parse_player(r#"{"playabilityStatus":{"status":"OK"}}"#).unwrap();
        assert!(player.tracks.is_empty());
    }

    #[test]
    fn the_track_url_asks_for_json3_instead_of_srv3() {
        assert_eq!(
            json3_url("https://x.test/api/timedtext?v=a&lang=nl&fmt=srv3&kind=asr"),
            "https://x.test/api/timedtext?v=a&lang=nl&kind=asr&fmt=json3"
        );
        assert_eq!(
            json3_url("https://x.test/api/timedtext?v=a"),
            "https://x.test/api/timedtext?v=a&fmt=json3"
        );
    }

    #[test]
    fn a_fetched_track_is_json3_that_sapling_import_reads() {
        let transport = fake(TRACK);
        let track = CaptionTrack {
            lang: "nl".to_owned(),
            name: String::new(),
            auto: true,
        };
        let json3 = block_on(fetch_track(&transport, "02w8LwJCgQY", &track)).unwrap();

        let seen = transport.seen.borrow();
        assert!(seen[1].url.contains("kind=asr&lang=nl&fmt=json3"));

        assert_eq!(
            sapling_import::detect_subtitle_format(&json3),
            Some(sapling_import::SubtitleFormat::Json3)
        );
        let imported = sapling_import::import_source(&json3);
        let texts: Vec<&str> = imported.segments.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(
            texts.first().copied(),
            Some("Vandaag zijn er verkiezingen in Israël.")
        );
        assert!(texts.iter().any(|t| t.contains("Gaza?")), "{texts:?}");
    }

    #[test]
    fn an_empty_track_is_reported_as_the_po_token_wall() {
        let track = CaptionTrack {
            lang: "nl".to_owned(),
            name: String::new(),
            auto: false,
        };
        let error = block_on(fetch_track(&fake(""), "02w8LwJCgQY", &track)).unwrap_err();
        assert!(error.contains("PO token"), "{error}");
    }

    #[test]
    fn a_track_the_video_does_not_have_is_an_error() {
        let track = CaptionTrack {
            lang: "fr".to_owned(),
            name: String::new(),
            auto: false,
        };
        assert!(block_on(fetch_track(&fake(TRACK), "02w8LwJCgQY", &track)).is_err());
    }
}
