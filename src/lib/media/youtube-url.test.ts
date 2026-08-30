/**
 * Every shape a YouTube link arrives in, and the ones that must not be taken
 * for one. The id is what ends up in an iframe, so the negatives matter as much
 * as the positives: a host test that passed `youtube.com.example.net` would be
 * a link the learner pasted deciding what this app embeds.
 */

import { describe, expect, it } from 'vitest';

import { videoIdFrom } from './youtube-url';

/** One real-shaped id, reused, so a failure is about the parse and not the value. */
const ID = 'dQw4w9WgXcQ';

describe('videoIdFrom', () => {
	it('takes the watch URL the address bar gives', () => {
		expect(videoIdFrom(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
	});

	it('ignores the other parameters around it', () => {
		expect(videoIdFrom(`https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123&index=2`)).toBe(ID);
		expect(videoIdFrom(`https://www.youtube.com/watch?list=PL123&v=${ID}`)).toBe(ID);
	});

	it('takes the short link the share sheet gives, `si=` and all', () => {
		expect(videoIdFrom(`https://youtu.be/${ID}`)).toBe(ID);
		expect(videoIdFrom(`https://youtu.be/${ID}?si=AbCdEf&t=90`)).toBe(ID);
	});

	it('takes shorts, embed and live', () => {
		expect(videoIdFrom(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
		expect(videoIdFrom(`https://www.youtube.com/embed/${ID}?start=30`)).toBe(ID);
		expect(videoIdFrom(`https://www.youtube.com/live/${ID}`)).toBe(ID);
	});

	it('takes the mobile, music and nocookie hosts', () => {
		expect(videoIdFrom(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
		expect(videoIdFrom(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID);
		expect(videoIdFrom(`https://www.youtube-nocookie.com/embed/${ID}`)).toBe(ID);
	});

	it('does not need a scheme, or http rather than https', () => {
		expect(videoIdFrom(`youtube.com/watch?v=${ID}`)).toBe(ID);
		expect(videoIdFrom(`www.youtube.com/watch?v=${ID}`)).toBe(ID);
		expect(videoIdFrom(`youtu.be/${ID}`)).toBe(ID);
		expect(videoIdFrom(`//youtu.be/${ID}`)).toBe(ID);
		expect(videoIdFrom(`http://youtube.com/watch?v=${ID}`)).toBe(ID);
	});

	it('ignores the whitespace a paste brings with it', () => {
		expect(videoIdFrom(`  https://youtu.be/${ID}\n`)).toBe(ID);
		expect(videoIdFrom(` ${ID} `)).toBe(ID);
	});

	it('takes a bare id, the one non-URL a learner might reasonably paste', () => {
		expect(videoIdFrom(ID)).toBe(ID);
		expect(videoIdFrom('_-aBcDeFgHi')).toBe('_-aBcDeFgHi');
	});

	it('refuses an id of the wrong length', () => {
		expect(videoIdFrom('dQw4w9WgXc')).toBeUndefined();
		expect(videoIdFrom('dQw4w9WgXcQQ')).toBeUndefined();
		expect(videoIdFrom(`https://www.youtube.com/watch?v=dQw4w9WgXc`)).toBeUndefined();
	});

	it('refuses a host that merely contains one of ours', () => {
		expect(videoIdFrom(`https://youtube.com.example.net/watch?v=${ID}`)).toBeUndefined();
		expect(videoIdFrom(`https://notyoutube.com/watch?v=${ID}`)).toBeUndefined();
		expect(videoIdFrom(`https://evil.example/youtu.be/${ID}`)).toBeUndefined();
	});

	it('refuses a YouTube page that is not a video', () => {
		expect(videoIdFrom('https://www.youtube.com/')).toBeUndefined();
		expect(videoIdFrom('https://www.youtube.com/results?search_query=hello')).toBeUndefined();
		expect(videoIdFrom('https://www.youtube.com/@someone')).toBeUndefined();
		expect(videoIdFrom('https://www.youtube.com/playlist?list=PL123')).toBeUndefined();
	});

	it('refuses everything else, including nothing at all', () => {
		expect(videoIdFrom('')).toBeUndefined();
		expect(videoIdFrom('   ')).toBeUndefined();
		expect(videoIdFrom('https://example.com/watch?v=' + ID)).toBeUndefined();
		expect(videoIdFrom('a sentence about a video')).toBeUndefined();
		expect(videoIdFrom(`javascript:alert(1)//youtu.be/${ID}`)).toBeUndefined();
	});
});
