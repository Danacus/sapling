/**
 * The lock-and-clock every challenge component was hand-rolling.
 *
 * All six types share the same three-line ritual: a `locked` flag flipped just
 * before `onanswer` so a second tap cannot double-report, a `shownAt` stamp the
 * response time is measured from, and an `$effect` keyed on `challenge.id` that
 * resets both when the host swaps in the next challenge. Six copies is six
 * chances for one of them to forget the reset — and a forgotten reset is a
 * challenge that arrives already locked, or one that reports a response time
 * measured from a challenge two ago.
 *
 * The id read is what makes the reset happen: `challengeId()` is called inside
 * the effect, so it is a tracked read of the *current* challenge's id, and the
 * effect re-runs on every swap. Components pass their own state-clearing
 * closure as `reset`, which runs in the same beat, before anything renders.
 *
 * Runes in a module: this is a `.svelte.ts` file, so `$state` and `$effect`
 * compile here exactly as they do in a component. {@link createAnswerLock} must
 * therefore be called during component initialisation, like any other rune.
 */

/** A challenge's lock, its clock, and the reset that ties them to the id. */
export interface AnswerLock {
	/** The learner has committed; every handler should bail out on this. */
	readonly locked: boolean;
	/** When the current challenge was first shown, as epoch ms. */
	readonly shownAt: number;
	/**
	 * Lock, and report how long the learner took — the `responseMs` an
	 * `AnswerEvent` carries. Call it once, immediately before `onanswer`.
	 */
	commit(): number;
}

/**
 * Creates the lock for one challenge component.
 *
 * @param challengeId Reads the current `challenge.id`. A function rather than a
 * value so the read happens inside the effect, where it is tracked.
 * @param reset Clears the component's own per-challenge state (the selection,
 * the typed text, the tray). Runs on first render too, which is harmless: it
 * only ever restores the initial values.
 */
export function createAnswerLock(challengeId: () => string, reset?: () => void): AnswerLock {
	let locked = $state(false);
	let shownAt = $state(Date.now());

	$effect(() => {
		void challengeId();
		locked = false;
		shownAt = Date.now();
		reset?.();
	});

	return {
		get locked() {
			return locked;
		},
		get shownAt() {
			return shownAt;
		},
		commit() {
			locked = true;
			return Date.now() - shownAt;
		}
	};
}
