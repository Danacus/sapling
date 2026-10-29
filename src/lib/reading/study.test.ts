import { describe, expect, it } from 'vitest';

import {
	IDLE_MS,
	MIN_SPAN_MS,
	SPAN_CAP_MS,
	studyTracker,
	type StudySignal,
	type StudySpan
} from './study';

const T0 = 1_710_064_800_000;
const S = 1_000;
const MIN = 60 * S;

/** A tracker on a clock the test moves, and every span it wrote. */
function rig(visible = true, playing = false) {
	let now = T0;
	const spans: StudySpan[] = [];
	const tracker = studyTracker({
		now: () => now,
		write: (span) => spans.push(span),
		visible,
		playing
	});
	return {
		spans,
		at(ms: number, signal: StudySignal) {
			now = T0 + ms;
			tracker.signal(signal);
		}
	};
}

describe('studyTracker', () => {
	it('counts nothing for a visible page nobody touches', () => {
		const r = rig();
		r.at(10 * MIN, { kind: 'tick' });
		r.at(11 * MIN, { kind: 'leave' });
		expect(r.spans).toEqual([]);
	});

	it('closes a reading span where it went idle, two minutes after the last input', () => {
		const r = rig();
		r.at(0, { kind: 'input' });
		r.at(30 * S, { kind: 'input' });
		// Noticed late; the span still ends at 30 s + IDLE_MS.
		r.at(10 * MIN, { kind: 'tick' });
		expect(r.spans).toEqual([{ at: T0, ms: 30 * S + IDLE_MS }]);
	});

	it('keeps a playing recording active without input, and closes on pause', () => {
		const r = rig();
		r.at(0, { kind: 'playing', playing: true });
		r.at(4 * MIN, { kind: 'playing', playing: false });
		expect(r.spans).toEqual([{ at: T0, ms: 4 * MIN }]);
		// Nothing was touched, so a pause leaves the learner idle.
		r.at(20 * MIN, { kind: 'tick' });
		expect(r.spans).toHaveLength(1);
	});

	it('starts a span at once for a recording already playing when it is built', () => {
		const r = rig(true, true);
		r.at(MIN, { kind: 'leave' });
		expect(r.spans).toEqual([{ at: T0, ms: MIN }]);
	});

	it('opens the next span at once when a pause leaves recent input', () => {
		const r = rig();
		r.at(0, { kind: 'playing', playing: true });
		r.at(2 * MIN, { kind: 'input' });
		r.at(2 * MIN + S, { kind: 'playing', playing: false });
		r.at(3 * MIN, { kind: 'leave' });
		expect(r.spans).toEqual([
			{ at: T0, ms: 2 * MIN + S },
			{ at: T0 + 2 * MIN + S, ms: MIN - S }
		]);
	});

	it('caps a span at five minutes and carries on in a new one', () => {
		const r = rig();
		r.at(0, { kind: 'playing', playing: true });
		r.at(12 * MIN, { kind: 'tick' });
		expect(r.spans).toEqual([
			{ at: T0, ms: SPAN_CAP_MS },
			{ at: T0 + SPAN_CAP_MS, ms: SPAN_CAP_MS }
		]);
		r.at(13 * MIN, { kind: 'leave' });
		expect(r.spans.at(-1)).toEqual({ at: T0 + 2 * SPAN_CAP_MS, ms: 3 * MIN });
	});

	it('caps a span that went idle past the cap before it closes it', () => {
		const r = rig();
		r.at(0, { kind: 'input' });
		r.at(2 * MIN, { kind: 'input' });
		r.at(4 * MIN, { kind: 'input' });
		r.at(20 * MIN, { kind: 'tick' });
		// Active until 6 min: one capped span, then the last minute.
		expect(r.spans).toEqual([
			{ at: T0, ms: SPAN_CAP_MS },
			{ at: T0 + SPAN_CAP_MS, ms: MIN }
		]);
	});

	it('closes on hidden and resumes on visible while input is recent', () => {
		const r = rig();
		r.at(0, { kind: 'input' });
		r.at(MIN, { kind: 'visible', visible: false });
		expect(r.spans).toEqual([{ at: T0, ms: MIN }]);
		// Hidden time is never counted, playing or not.
		r.at(MIN + 10 * S, { kind: 'playing', playing: true });
		r.at(MIN + 30 * S, { kind: 'visible', visible: true });
		r.at(2 * MIN + 30 * S, { kind: 'leave' });
		expect(r.spans).toEqual([
			{ at: T0, ms: MIN },
			{ at: T0 + MIN + 30 * S, ms: MIN }
		]);
	});

	it('drops a span shorter than the minimum', () => {
		const r = rig();
		r.at(0, { kind: 'input' });
		r.at(MIN_SPAN_MS - 1, { kind: 'visible', visible: false });
		r.at(MIN, { kind: 'visible', visible: true });
		r.at(MIN, { kind: 'input' });
		r.at(MIN + MIN_SPAN_MS, { kind: 'leave' });
		expect(r.spans).toEqual([{ at: T0 + MIN, ms: MIN_SPAN_MS }]);
	});

	it('counts nothing after leaving, whatever arrives late', () => {
		const r = rig();
		r.at(0, { kind: 'input' });
		r.at(MIN, { kind: 'leave' });
		r.at(5 * MIN, { kind: 'tick' });
		expect(r.spans).toEqual([{ at: T0, ms: MIN }]);
	});
});
