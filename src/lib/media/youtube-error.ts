/**
 * What YouTube's `onError` code means, in a sentence a learner can act on.
 *
 * The API reports failure the same way it reports everything else — a number on
 * an event — and a player that has errored simply stops, leaving a black
 * rectangle where the video was. Until this existed the reader had no way to
 * tell that apart from a slow load, so the frame just sat there; every code
 * below now reaches `onFail` and becomes the one line the stage shows instead of
 * the picture, with the text underneath untouched.
 *
 * Pure and separate from `youtube.ts` for the same reason `youtube-url.ts` is:
 * the file that touches the iframe cannot be tested in node, and this is the
 * only part of the failure path that can be wrong.
 *
 * The codes are YouTube's own, and 153 is the one that started this: it is what
 * the player answers when it cannot establish a valid referer, which is every
 * embed served from `tauri://localhost`. See `embed-protocol.ts` for the fix;
 * this is what the learner sees when the fix is not in place.
 */

/** The message for YouTube's error `code`, always a complete sentence. */
export function playerErrorMessage(code: number): string {
	switch (code) {
		case 2:
			// "Invalid parameter" — in practice an id the API refuses to look up.
			return 'YouTube did not recognise that video.';
		case 5:
			return 'YouTube could not play this video in its player.';
		case 100:
			return 'That video is no longer on YouTube.';
		case 101:
		case 150:
			// Two codes, one cause: the uploader turned embedding off. The video
			// itself is fine, which is worth saying — the link still works.
			return 'The owner of that video does not allow it to be played outside YouTube.';
		case 153:
			return 'YouTube would not start its player here (configuration error 153).';
		default:
			return `The YouTube player stopped with error ${code}.`;
	}
}
