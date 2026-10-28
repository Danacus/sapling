//! A YouTube video's captions by name, like the `sync!` table: async, one
//! argument object each, over the host's [`Transport`]. A failure is the
//! learner-facing text as `Err`. The table also generates the TypeScript
//! `Captions` interface and `CAPTION_METHODS` (`captions.ts`).

use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use sapling_captions::innertube::{self, Transport};
use sapling_captions::{CaptionTrack, CaptionsListing};

use crate::required;

/// The video asked about.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VideoArgs {
    pub video_id: String,
}

/// One track of one video.
#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TrackArgs {
    pub video_id: String,
    pub track: CaptionTrack,
}

macro_rules! captions {
    (
        |$transport:ident| {
            $(
                $(#[doc = $doc:literal])*
                $method:ident($arg:ident: $ty:ty) -> $ret:ty $body:block
            )*
        }
    ) => {
        /// Runs one captions call by name.
        #[allow(non_snake_case)]
        pub async fn dispatch_captions<T: Transport>(
            $transport: &T,
            method: &str,
            args: &[Value],
        ) -> Result<Value, String> {
            match method {
                $(
                    stringify!($method) => {
                        let $arg: $ty = required(method, args, 0).map_err(|e| e.0)?;
                        let value: $ret = $body.await?;
                        serde_json::to_value(value).map_err(|e| e.to_string())
                    }
                )*
                _ => Err(format!("Unknown captions method {method}")),
            }
        }

        #[cfg(test)]
        pub(crate) fn caption_methods(cfg: &ts_rs::Config) -> Vec<crate::typescript::Method> {
            vec![$(
                crate::typescript::Method {
                    name: stringify!($method),
                    docs: &[$($doc),*],
                    params: vec![(stringify!($arg), false, <$ty as ts_rs::TS>::name(cfg))],
                    returns: <$ret as ts_rs::TS>::name(cfg),
                },
            )*]
        }

        #[cfg(test)]
        pub(crate) fn visit_caption_types(visitor: &mut impl ts_rs::TypeVisitor) {
            $(
                visitor.visit::<$ty>();
                visitor.visit::<$ret>();
            )*
        }
    };
}

captions! {
    |transport| {
        /// Every caption track the video has, manual ones first.
        listCaptions(args: VideoArgs) -> CaptionsListing {
            innertube::list_tracks(transport, &args.video_id)
        }
        /// One track as raw `json3`, for `importSource` to read.
        fetchCaptions(args: TrackArgs) -> String {
            innertube::fetch_track(transport, &args.video_id, &args.track)
        }
    }
}

/// [`dispatch_captions`] over the wire: the answer as JSON, or plain text.
pub async fn dispatch_captions_json<T: Transport>(
    transport: &T,
    method: &str,
    args_json: &str,
) -> Result<String, String> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| format!("{method}: arguments are not a JSON array: {e}"))?;
    dispatch_captions(transport, method, &args)
        .await
        .map(|answer| answer.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sapling_captions::innertube::{Request, Response};
    use std::future::{ready, Future};

    /// Answers every request with one status and body.
    struct Canned(u16, &'static str);

    impl Transport for Canned {
        fn send(&self, _: Request) -> impl Future<Output = Result<Response, String>> {
            ready(Ok(Response {
                status: self.0,
                body: self.1.to_owned(),
            }))
        }
    }

    fn call(transport: &Canned, method: &str, args: &str) -> Result<String, String> {
        pollster::block_on(dispatch_captions_json(transport, method, args))
    }

    #[test]
    fn a_listing_answers_as_json() {
        let player = r#"{"playabilityStatus":{"status":"OK"},"videoDetails":{"title":"T"}}"#;
        let answer = call(
            &Canned(200, player),
            "listCaptions",
            r#"[{"videoId":"abcdefghijk"}]"#,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&answer).unwrap(),
            serde_json::json!({ "id": "abcdefghijk", "title": "T", "tracks": [] })
        );
    }

    #[test]
    fn a_failure_is_the_plain_text_for_the_learner() {
        let error = call(
            &Canned(403, ""),
            "fetchCaptions",
            r#"[{"videoId":"abcdefghijk","track":{"lang":"nl","name":"Dutch","auto":false}}]"#,
        )
        .unwrap_err();
        assert!(error.contains("403"), "{error}");
    }

    #[test]
    fn a_malformed_call_is_plain_text() {
        let canned = Canned(200, "{}");
        assert_eq!(
            call(&canned, "nope", "[]").unwrap_err(),
            "Unknown captions method nope"
        );
        assert!(call(&canned, "listCaptions", "[]")
            .unwrap_err()
            .starts_with("listCaptions: argument 0"));
    }
}
