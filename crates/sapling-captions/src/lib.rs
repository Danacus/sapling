//! A YouTube video's caption tracks, as the file a subtitle import reads.
//!
//! [`innertube`] lists a video's tracks and fetches one as `json3` over an HTTP
//! transport the host lends, as `sapling-sync` does: the browser's is a
//! sandboxed-iframe relay (`src/lib/media/youtube-relay.ts`), a native host's
//! is [`native`]. **Nothing here parses a caption file**: `json3` goes to
//! `sapling-import` verbatim, where the app's one subtitle parser lives.

#![forbid(unsafe_code)]

pub mod innertube;
#[cfg(feature = "native")]
pub mod native;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One caption track a video carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaptionTrack {
    /// YouTube's language code for it.
    pub lang: String,
    /// What to call it on screen: YouTube's name, or the code where it has none.
    pub name: String,
    /// Speech recognition rather than written by a person — usually
    /// unpunctuated and cued word by word.
    pub auto: bool,
}

/// What a video turned out to have.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CaptionsListing {
    pub id: String,
    pub title: String,
    /// Manual tracks first, then the automatic ones.
    pub tracks: Vec<CaptionTrack>,
}
