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
 * Everything that could be *wrong* about following a subtitle track is in
 * `follow.ts`, which is pure and tested: which line is current, when a line has
 * just ended, which line is next. The element wrapper is deliberately thin so
 * there is nothing in it to test in a node environment that has no media.
 *
 * **Milliseconds above `video.ts`, seconds inside it** — the DOM's clock is
 * seconds and a subtitle file's is milliseconds, and that conversion happens at
 * exactly one boundary.
 *
 * Stateless like `$lib/reading`: **nothing here imports `$lib/db`.** The one
 * piece of state is `files.ts`'s session cache of `File` handles, which is a
 * cache of something the OS owns, not a fact about the learner — a recording is
 * never stored, only its name (see `$lib/types`' `ReadingMedia`).
 */

export { crossedEnd, firstTimed, nextTimed, prevTimed, sentenceAt, startOf } from './follow';
export type { Timed } from './follow';
export { forgetFile, objectUrl, rememberFile, takeFile } from './files';
export type { Player } from './player';
export { videoPlayer } from './video';
export { youtubePlayer } from './youtube';
export type { YouTubeOptions } from './youtube';
export { videoIdFrom } from './youtube-url';
