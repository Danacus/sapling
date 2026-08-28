import { describe, expect, it } from 'vitest';

import { bestTranscript, micErrorMessage } from './webspeech';
import type { ResultListLike } from './webspeech';

/** Builds the array-like shape the browser hands `onresult`. */
function results(...parts: { transcript: string; isFinal: boolean }[]): ResultListLike {
	return Object.assign(
		parts.map((part) =>
			Object.assign([{ transcript: part.transcript }], { isFinal: part.isFinal })
		),
		{ length: parts.length }
	) as unknown as ResultListLike;
}

describe('bestTranscript', () => {
	it('takes the top alternative of a single final result', () => {
		expect(bestTranscript(results({ transcript: '我想要一杯咖啡', isFinal: true }))).toEqual({
			text: '我想要一杯咖啡',
			final: true
		});
	});

	it('concatenates the cumulative results in order', () => {
		const list = results(
			{ transcript: 'I would like', isFinal: true },
			{ transcript: ' a coffee', isFinal: true }
		);
		expect(bestTranscript(list).text).toBe('I would like a coffee');
	});

	it('is not final while any result is still being revised', () => {
		const list = results(
			{ transcript: 'I would like', isFinal: true },
			{ transcript: ' a cough', isFinal: false }
		);
		expect(bestTranscript(list).final).toBe(false);
	});

	it('trims the engine leading space so an empty composer gets no indent', () => {
		expect(bestTranscript(results({ transcript: ' hello', isFinal: true })).text).toBe('hello');
	});

	it('reports an empty list as not final, so nothing is committed', () => {
		expect(bestTranscript(results())).toEqual({ text: '', final: false });
	});
});

describe('micErrorMessage', () => {
	it('speaks up about a microphone the learner can still fix', () => {
		expect(micErrorMessage('not-allowed')).toMatch(/blocked/i);
		expect(micErrorMessage('service-not-allowed')).toMatch(/blocked/i);
		expect(micErrorMessage('audio-capture')).toMatch(/microphone/i);
		expect(micErrorMessage('network')).toBeTypeOf('string');
	});

	it('stays silent about an ordinary stop', () => {
		// Saying nothing, and our own abort(), are not failures.
		expect(micErrorMessage('no-speech')).toBeUndefined();
		expect(micErrorMessage('aborted')).toBeUndefined();
		expect(micErrorMessage('something-new')).toBeUndefined();
	});
});
