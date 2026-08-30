/**
 * The session cache. What it has to get right is small but load-bearing: the
 * open straight after an import finds the file, a second open in the same
 * session still finds it (the reader mounts more than once), and nothing about
 * it survives being forgotten.
 *
 * `objectUrl` is not exercised here — `URL.createObjectURL` is a browser API and
 * this suite is node — and it is two lines whose only job is to hand the revoke
 * back beside the url it belongs to.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { forgetFile, rememberFile, takeFile } from './files';

/** A stand-in for the learner's recording; only its identity is ever checked. */
function fake(name: string): File {
	return new File(['not really a video'], name, { type: 'video/mp4' });
}

describe('the session file cache', () => {
	beforeEach(() => {
		forgetFile('a');
		forgetFile('b');
	});

	it('has nothing for a text that was never given one', () => {
		expect(takeFile('a')).toBeUndefined();
	});

	it('gives back the file the composer remembered', () => {
		const file = fake('lesson.mp4');
		rememberFile('a', file);
		expect(takeFile('a')).toBe(file);
	});

	it('keeps it across repeated reads, because the reader mounts more than once', () => {
		const file = fake('lesson.mp4');
		rememberFile('a', file);
		expect(takeFile('a')).toBe(file);
		expect(takeFile('a')).toBe(file);
	});

	it('keeps one file per text', () => {
		const one = fake('one.mp4');
		const two = fake('two.mp4');
		rememberFile('a', one);
		rememberFile('b', two);
		expect(takeFile('a')).toBe(one);
		expect(takeFile('b')).toBe(two);
	});

	it('replaces the handle when the learner picks another file', () => {
		rememberFile('a', fake('one.mp4'));
		const renamed = fake('one (1).mp4');
		rememberFile('a', renamed);
		expect(takeFile('a')).toBe(renamed);
	});

	it('forgets on request, and forgetting an unknown text is not an error', () => {
		rememberFile('a', fake('one.mp4'));
		forgetFile('a');
		expect(takeFile('a')).toBeUndefined();
		expect(() => forgetFile('nope')).not.toThrow();
	});
});
