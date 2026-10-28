//! [`innertube`] for a native host: ureq, blocking, and no `Origin` at all,
//! which the `player` endpoint accepts. Call it off any UI thread.

use pollster::block_on;

use crate::innertube::{self, Method, Request, Response, Transport};
use crate::{CaptionTrack, CaptionsListing};

/// A caption track is a few hundred KB; this only bounds a runaway answer.
const BODY_LIMIT: u64 = 32 * 1024 * 1024;

pub struct Ureq(ureq::Agent);

impl Default for Ureq {
    fn default() -> Self {
        // A 4xx is an answer `innertube` reports, not a transport failure.
        Self(
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .build()
                .into(),
        )
    }
}

impl Transport for Ureq {
    async fn send(&self, request: Request) -> Result<Response, String> {
        let result = match request.method {
            Method::Get => self.0.get(&request.url).call(),
            Method::Post => self
                .0
                .post(&request.url)
                .header("Content-Type", "text/plain")
                .send(request.body.unwrap_or_default()),
        };
        let mut response =
            result.map_err(|cause| format!("YouTube could not be reached: {cause}"))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(BODY_LIMIT)
            .read_to_string()
            .map_err(|cause| format!("YouTube's answer could not be read: {cause}"))?;
        Ok(Response { status, body })
    }
}

/// [`innertube::list_tracks`], blocking.
pub fn list(video_id: &str) -> Result<CaptionsListing, String> {
    block_on(innertube::list_tracks(&Ureq::default(), video_id))
}

/// [`innertube::fetch_track`], blocking.
pub fn fetch(video_id: &str, track: &CaptionTrack) -> Result<String, String> {
    block_on(innertube::fetch_track(&Ureq::default(), video_id, track))
}
