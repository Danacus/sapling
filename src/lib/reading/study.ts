/**
 * How long the learner actually studied a text — the spans a `studied` event
 * records, for the study-time read (`studySessions`) a leaderboard is fed from.
 *
 * Pure in the house style: no clock, no element, no store. The page feeds it
 * signals with the time they happened and persists what comes out; a test
 * holds the clock still. The wrapper at the bottom adds only a clock and a
 * writer, both injected.
 *
 * **Active** is: the page is visible, *and* the learner did something in the
 * last {@link IDLE_MS} or the recording is playing. A span is one continuous
 * stretch of that, so its length is its wall-clock length — which is what lets
 * the core split it across hours by its interval alone. A span closes when
 * activity lapses (at the moment it lapsed — two minutes after the last input,
 * not when a timer next noticed), when the recording pauses or ends, when the
 * page is hidden or left, and every {@link SPAN_CAP_MS} of activity, so a crash
 * or a killed tab loses at most that much. A close that leaves the learner
 * still active (a pause two seconds after a tap) opens the next span at once.
 * A span shorter than {@link MIN_SPAN_MS} is dropped: a glance says nothing,
 * and it keeps the boundary splits from littering the log.
 */

/** No input for this long, and nothing playing, is idle. */
export const IDLE_MS = 2 * 60_000;
/** A span this long is written and a new one started. */
export const SPAN_CAP_MS = 5 * 60_000;
/** Spans shorter than this are not written. */
export const MIN_SPAN_MS = 5_000;

/** One closed span: it began at `at` (epoch ms) and was active for `ms`. */
export interface StudySpan {
	at: number;
	ms: number;
}

/** What the page tells the tracker. */
export type StudySignal =
	| { kind: 'input' }
	| { kind: 'playing'; playing: boolean }
	| { kind: 'visible'; visible: boolean }
	/** Nothing happened; settle what the passing time decided (idle, the cap). */
	| { kind: 'tick' }
	/** The page is going away: close whatever is open. */
	| { kind: 'leave' };

export interface StudyState {
	visible: boolean;
	playing: boolean;
	/** When the learner last did something, if ever. */
	lastInput?: number;
	/** Where the open span began; absent while idle. */
	start?: number;
}

export function initialStudy(visible: boolean, playing = false): StudyState {
	return { visible, playing };
}

/** Until when the learner counts as active, given nothing else happens. */
function activeUntil(state: StudyState): number {
	if (!state.visible) return -Infinity;
	if (state.playing) return Infinity;
	return state.lastInput === undefined ? -Infinity : state.lastInput + IDLE_MS;
}

/**
 * One signal at `now`: the next state, and the spans it closed, oldest first.
 *
 * First the open span is settled up to `now` under the conditions that held
 * until now — capped as often as it ran past the cap, and closed where it went
 * idle — then the signal applies, closing the span on a boundary and opening
 * one if the learner is active.
 */
export function stepStudy(
	state: StudyState,
	signal: StudySignal,
	now: number
): { state: StudyState; spans: StudySpan[] } {
	const spans: StudySpan[] = [];
	const emit = (at: number, ms: number) => {
		if (ms >= MIN_SPAN_MS) spans.push({ at, ms });
	};
	const next: StudyState = { ...state };

	if (next.start !== undefined) {
		const end = Math.min(now, activeUntil(next));
		while (end - next.start >= SPAN_CAP_MS) {
			emit(next.start, SPAN_CAP_MS);
			next.start += SPAN_CAP_MS;
		}
		if (end < now) {
			emit(next.start, end - next.start);
			next.start = undefined;
		}
	}

	let boundary = false;
	switch (signal.kind) {
		case 'input':
			next.lastInput = now;
			break;
		case 'playing':
			boundary = next.playing && !signal.playing;
			next.playing = signal.playing;
			break;
		case 'visible':
			boundary = next.visible && !signal.visible;
			next.visible = signal.visible;
			break;
		case 'leave':
			boundary = true;
			next.visible = false;
			next.playing = false;
			next.lastInput = undefined;
			break;
		case 'tick':
			break;
	}

	if (next.start !== undefined && (boundary || activeUntil(next) <= now)) {
		emit(next.start, now - next.start);
		next.start = undefined;
	}
	if (next.start === undefined && activeUntil(next) > now) next.start = now;
	return { state: next, spans };
}

export interface StudyTracker {
	signal(signal: StudySignal): void;
}

/** {@link stepStudy} over a clock, handing every closed span to `write`. */
export function studyTracker(options: {
	now: () => number;
	write: (span: StudySpan) => void;
	visible: boolean;
	playing?: boolean;
}): StudyTracker {
	// A recording already playing is a span from the first instant.
	let state = stepStudy(
		initialStudy(options.visible, options.playing),
		{ kind: 'tick' },
		options.now()
	).state;
	return {
		signal(signal) {
			const step = stepStudy(state, signal, options.now());
			state = step.state;
			for (const span of step.spans) options.write(span);
		}
	};
}
