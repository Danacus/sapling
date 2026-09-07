//! The microphone permission on WebKitGTK, which nothing but the application
//! can grant.
//!
//! Everything else about capture is still the window's: `getUserMedia` →
//! `AudioWorkletNode` → PCM over the IPC, in `src/lib/asr/native.ts`, and this
//! crate has no recorder, no device enumeration and no `rodio/recording`. What
//! it turns out the window cannot do is *be asked*. WebKitGTK has no permission
//! UI: it emits `permission-request` on the `WebKitWebView` and, when nothing
//! handles the signal, **denies** the request. wry 0.55.1 connects WebGL,
//! WebAudio and the clipboard settings and not that signal, and Tauri connects
//! nothing either — so every dictation on this host failed instantly with a
//! `NotAllowedError`, which `src/lib/asr/native.ts` correctly reports as
//! "Microphone access is blocked. Allow it in your browser settings to
//! dictate." There is no such setting: on this webview there is no prompt to
//! answer and no browser to answer it in.
//!
//! So this module is the desktop counterpart of Android's manifest line, and it
//! is deliberately that small. There the runtime request is answered by wry's
//! own `RustWebChromeClient` and all the app supplies is the declaration that
//! `RECORD_AUDIO` is wanted; here the app supplies the answer itself, because
//! there is nobody else to. **It is a declaration and not a capability**: no
//! audio, no device and no sample passes through this file, so the rule that
//! the microphone is not in this crate is intact — what arrived is the
//! permission, not the recorder.
//!
//! ## Audio, and only audio
//!
//! The signal carries one request object per `getUserMedia` call, and a
//! `UserMediaPermissionRequest` says which devices the page asked for. Audio
//! alone is [`Answer::Allow`], because a learner who pressed 🎤 asked for
//! exactly that. Anything that wants a camera is [`Answer::Deny`] — nothing in
//! Sapling has ever opened one, so a request for one is a page doing something
//! unasked-for, and a host that granted it by inheriting a rule about
//! microphones would be the wrong kind of generous. Everything else WebKitGTK
//! asks about — geolocation, notifications, a missing media plugin, clipboard
//! read — is [`Answer::Default`]: the handler returns `false`, says nothing,
//! and WebKitGTK does what it would have done, which is deny.
//!
//! ## Why the decision is a function and the handler is four lines
//!
//! No test here can open a webview, so the part worth pinning is not the
//! plumbing but the rule: which of the three answers each shape of request
//! gets. [`answer`] is that rule over [`Request`], with nothing in it but a
//! `match`, and [`connect`] is the adapter that reads a `WebKitPermissionRequest`
//! into one and calls `allow()`/`deny()` on the way back out.
//!
//! The whole module is `#[cfg(target_os = "linux")]`, like the `webkit2gtk`
//! dependency it needs: this is a fact about one webview, and the phone's
//! compiler never sees it.

use tauri::{Runtime, WebviewWindow};
use webkit2gtk::glib::prelude::Cast;
use webkit2gtk::{
    PermissionRequest, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
    UserMediaPermissionRequestExt, WebViewExt,
};

/// What a `permission-request` is asking for, reduced to the facts the answer
/// turns on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    /// A `getUserMedia` call, and the devices it named. Both flags matter and
    /// neither implies the other: WebKitGTK asks once for whatever the page
    /// asked for, so a call for audio *and* video is one request with both set.
    UserMedia { audio: bool, video: bool },
    /// Any other permission this webview asks the application about.
    Other,
}

/// The three things a `permission-request` handler can do. `Allow` and `Deny`
/// both answer the request and return `true`; `Default` returns `false` and
/// leaves it to WebKitGTK, which denies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Allow,
    Deny,
    Default,
}

/// The whole policy: a microphone the learner asked for, and nothing else.
///
/// `audio` is a positive condition rather than "not video", so a `getUserMedia`
/// that somehow named no device at all is denied rather than allowed by
/// omission.
pub fn answer(request: Request) -> Answer {
    match request {
        Request::UserMedia {
            audio: true,
            video: false,
        } => Answer::Allow,
        Request::UserMedia { .. } => Answer::Deny,
        Request::Other => Answer::Default,
    }
}

/// Reads one `WebKitPermissionRequest` into the shape [`answer`] decides over.
fn classify(request: &PermissionRequest) -> Request {
    match request.downcast_ref::<UserMediaPermissionRequest>() {
        Some(media) => Request::UserMedia {
            audio: media.is_for_audio_device(),
            video: media.is_for_video_device(),
        },
        None => Request::Other,
    }
}

/// Puts [`answer`] on the window's webview, so a `getUserMedia` for the
/// microphone is granted instead of refused.
///
/// The closure runs on the GTK thread that owns the webview — which is what
/// `with_webview` is for — and connects a signal that lives as long as the
/// view. It also turns `enable-media-stream` on if it is not already: the
/// setting gates whether `navigator.mediaDevices` exists at all, wry does not
/// touch it, and a webview that has it off would refuse before any request
/// reached the signal.
pub fn connect<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    window.with_webview(|platform| {
        let view = platform.inner();
        if let Some(settings) = view.settings() {
            if !settings.enables_media_stream() {
                settings.set_enable_media_stream(true);
            }
        }
        view.connect_permission_request(|_, request| match answer(classify(request)) {
            Answer::Allow => {
                request.allow();
                true
            }
            Answer::Deny => {
                request.deny();
                true
            }
            Answer::Default => false,
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_microphone_alone_is_allowed() {
        assert_eq!(
            answer(Request::UserMedia {
                audio: true,
                video: false
            }),
            Answer::Allow
        );
    }

    #[test]
    fn a_camera_is_denied() {
        assert_eq!(
            answer(Request::UserMedia {
                audio: false,
                video: true
            }),
            Answer::Deny
        );
    }

    #[test]
    fn a_camera_with_a_microphone_is_denied_as_a_whole() {
        assert_eq!(
            answer(Request::UserMedia {
                audio: true,
                video: true
            }),
            Answer::Deny
        );
    }

    /// Not a shape a page can really ask for, and denied on purpose: the rule
    /// is "audio was asked for", never "video was not".
    #[test]
    fn a_request_for_no_device_is_denied() {
        assert_eq!(
            answer(Request::UserMedia {
                audio: false,
                video: false
            }),
            Answer::Deny
        );
    }

    #[test]
    fn every_other_permission_keeps_webkits_own_answer() {
        assert_eq!(answer(Request::Other), Answer::Default);
    }
}
