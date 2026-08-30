/**
 * The seam every player in the app sits behind.
 *
 * There will be two: a `<video>` element pointed at a file on the learner's
 * disk, and — the next slice — YouTube's iframe API, which shares nothing with
 * it except this shape. Neither is worth teaching the reader about, so the
 * reader learns this instead: five verbs and a clock. What follows the clock
 * (`./follow`) is pure and takes numbers; what renders is a page; and what
 * plays is whichever of these was built for the text at hand.
 *
 * **Milliseconds everywhere.** `ReadingSentence.start`/`end` are milliseconds
 * because a subtitle file's are, and a `<video>`'s `currentTime` is seconds
 * because the DOM's is — that conversion belongs in exactly one file
 * (`./video`) and appears nowhere above it. A player that hands out seconds is
 * a bug the follow logic cannot see.
 */

/**
 * One playing recording, whatever is doing the playing.
 *
 * Deliberately poll-free at the top: `onTime` is a subscription rather than a
 * `currentTime` the caller has to sample, because the browser already fires on
 * every frame it advances and a reader that polled would either lag the
 * highlight or burn a timer on a paused video.
 */
export interface Player {
	/** Where playback is now, in milliseconds from the start of the recording. */
	currentTime(): number;
	/** Jumps to `ms`; does not start or stop playback by itself. */
	seek(ms: number): void;
	play(): void;
	pause(): void;
	paused(): boolean;
	/**
	 * Calls `cb` with the current position whenever it moves — including on a
	 * seek and on a pause, not only while playing, so the highlight is right the
	 * instant the learner lands somewhere rather than at the next tick.
	 *
	 * Returns the unsubscribe.
	 */
	onTime(cb: (ms: number) => void): () => void;
	/** Drops every listener and whatever the implementation is holding. */
	destroy(): void;
}
