/**
 * Playing the recording a text was subtitled from.
 *
 * A small area with one idea in it: **the player is a seam**. `Player`
 * (`player.ts`) is five verbs and a clock; `videoPlayer` (`video.ts`) is that
 * over a `<video>` element pointed at a file on the learner's disk, and
 * `youtubePlayer` (`youtube.ts`) is the same five verbs over YouTube's IFrame
 * API — a lazily loaded script, a polled clock and no `timeupdate` anywhere,
 * none of which reaches the reader. The reader knows the interface and never
 * learns which one it got; the only thing it decides is what to mount.
 * `videoIdFrom` (`youtube-url.ts`) is the one place a pasted link becomes an id.
 *
 * There is a **third** player and the reader does not learn about that either:
 * YouTube will not configure itself for a document with no HTTP(S) referer, so
 * the desktop shell (`tauri://localhost`) frames a hosted copy of `youtube.ts`
 * and drives it over `postMessage` — `youtube-framed.ts` and
 * `embed-protocol.ts`, chosen by `youtube-host.ts`, which is what the reader
 * calls and the only place `inTauri()` is asked in this area.
 *
 * Everything that could be *wrong* about following a subtitle track is in
 * `follow.ts`, which is pure and tested: which line is current, when a line has
 * just ended, which line is next. The element wrapper is deliberately thin so
 * there is nothing in it to test in a node environment that has no media.
 *
 * **Milliseconds above `video.ts`, seconds inside it** — the DOM's clock is
 * seconds and a subtitle file's is milliseconds, and that conversion happens at
 * exactly one boundary.
 *
 * `captions.ts` is the other host-shaped thing here, and it points the opposite
 * way: not how a video is *played* but how its subtitle track is *obtained*. A
 * browser cannot read a YouTube caption track at all, so the desktop shell runs
 * yt-dlp and hands back the file, which then goes through `$lib/reading`'s
 * ordinary subtitle door. It is the second module in this area to ask
 * `inTauri()`, for the same reason `youtube-host.ts` does.
 *
 * Stateless like `$lib/reading`: **nothing here imports `$lib/db`.** The one
 * piece of state is `files.ts`'s session cache of `File` handles, which is a
 * cache of something the OS owns, not a fact about the learner — a recording is
 * never stored, only its name (see `$lib/types`' `ReadingMedia`).
 */

export { captionsAvailable, fetchCaptions, listCaptions } from './captions';
export type { CaptionsListing, CaptionsTools, CaptionTrack } from './captions';
export {
	crossedEnd,
	firstTimed,
	nextTimed,
	prevTimed,
	sentenceAt,
	sentenceRangeAt,
	startOf
} from './follow';
export type { Timed } from './follow';
export { forgetFile, objectUrl, rememberFile, takeFile } from './files';
export { deadPlayer } from './player';
export type { Player } from './player';
export { videoPlayer } from './video';
export { youtubePlayer } from './youtube';
export type { YouTubeOptions } from './youtube';
export { playerErrorMessage } from './youtube-error';
export { framedYouTubePlayer } from './youtube-framed';
export { youtubePlayerForHost } from './youtube-host';
export { videoIdFrom, isVideoId } from './youtube-url';
