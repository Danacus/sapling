/**
 * The wire between the app and the hosted YouTube page.
 *
 * `window`'s `message` event is a channel shared with every frame, extension and
 * script on the page — YouTube's own API posts on it — so what these parsers
 * accept is the whole of what a stranger can make either side do. The negatives
 * matter as much as the positives, exactly as in `youtube-url.test.ts`: an
 * untagged object must never become a command, and a `seek` to `NaN` must never
 * reach a player.
 */

import { describe, expect, it } from 'vitest';

import {
	EMBED_PROTOCOL,
	embedFrameUrl,
	failEvent,
	parseCommand,
	parseEvent,
	pauseCommand,
	playCommand,
	readyEvent,
	seekCommand,
	timeEvent
} from './embed-protocol';

/** One real-shaped id, reused, so a failure is about the parse and not the value. */
const ID = 'dQw4w9WgXcQ';

describe('the message builders', () => {
	it('tags every message with the protocol and version', () => {
		for (const message of [
			playCommand(),
			pauseCommand(),
			seekCommand(0),
			readyEvent(),
			timeEvent(0, false),
			failEvent('nope')
		]) {
			expect(message.protocol).toBe(EMBED_PROTOCOL);
		}
	});

	it('clamps and rounds a position, so neither side has to wonder', () => {
		expect(seekCommand(-500)).toMatchObject({ type: 'seek', ms: 0 });
		expect(seekCommand(1200.6)).toMatchObject({ type: 'seek', ms: 1201 });
		expect(timeEvent(-1, true)).toMatchObject({ ms: 0 });
		expect(timeEvent(999.4, true)).toMatchObject({ ms: 999 });
	});

	it('round-trips through its own parser', () => {
		expect(parseCommand(playCommand())).toEqual(playCommand());
		expect(parseCommand(pauseCommand())).toEqual(pauseCommand());
		expect(parseCommand(seekCommand(42))).toEqual(seekCommand(42));
		expect(parseEvent(readyEvent())).toEqual(readyEvent());
		expect(parseEvent(timeEvent(42, true))).toEqual(timeEvent(42, true));
		expect(parseEvent(failEvent('gone'))).toEqual(failEvent('gone'));
	});
});

describe('parseCommand', () => {
	it('takes the three verbs', () => {
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'play' })?.type).toBe('play');
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'pause' })?.type).toBe('pause');
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'seek', ms: 7 })).toMatchObject({
			type: 'seek',
			ms: 7
		});
	});

	it('ignores anything not carrying this protocol', () => {
		expect(parseCommand({ type: 'play' })).toBeUndefined();
		expect(parseCommand({ protocol: 'sapling/youtube-embed@0', type: 'play' })).toBeUndefined();
		expect(parseCommand({ protocol: 'yt-player', type: 'play' })).toBeUndefined();
	});

	it('ignores anything that is not a tagged object at all', () => {
		expect(parseCommand(undefined)).toBeUndefined();
		expect(parseCommand(null)).toBeUndefined();
		expect(parseCommand('play')).toBeUndefined();
		expect(parseCommand(7)).toBeUndefined();
		expect(parseCommand([EMBED_PROTOCOL, 'play'])).toBeUndefined();
	});

	it('ignores a tagged message it does not know', () => {
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'destroy' })).toBeUndefined();
		expect(parseCommand({ protocol: EMBED_PROTOCOL })).toBeUndefined();
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 7 })).toBeUndefined();
	});

	it('refuses a seek that does not name a position', () => {
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'seek' })).toBeUndefined();
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'seek', ms: '7' })).toBeUndefined();
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'seek', ms: NaN })).toBeUndefined();
		expect(parseCommand({ protocol: EMBED_PROTOCOL, type: 'seek', ms: Infinity })).toBeUndefined();
	});

	it('does not take an event for a command', () => {
		expect(parseCommand(readyEvent())).toBeUndefined();
		expect(parseCommand(timeEvent(1, true))).toBeUndefined();
	});
});

describe('parseEvent', () => {
	it('takes the three announcements', () => {
		expect(parseEvent({ protocol: EMBED_PROTOCOL, type: 'ready' })?.type).toBe('ready');
		expect(
			parseEvent({ protocol: EMBED_PROTOCOL, type: 'time', ms: 250, playing: true })
		).toMatchObject({ ms: 250, playing: true });
		expect(
			parseEvent({ protocol: EMBED_PROTOCOL, type: 'fail', message: 'no player' })
		).toMatchObject({ message: 'no player' });
	});

	it('refuses a time that is missing either half of its news', () => {
		expect(parseEvent({ protocol: EMBED_PROTOCOL, type: 'time', ms: 250 })).toBeUndefined();
		expect(parseEvent({ protocol: EMBED_PROTOCOL, type: 'time', playing: true })).toBeUndefined();
		expect(
			parseEvent({ protocol: EMBED_PROTOCOL, type: 'time', ms: 250, playing: 'yes' })
		).toBeUndefined();
		expect(
			parseEvent({ protocol: EMBED_PROTOCOL, type: 'time', ms: NaN, playing: false })
		).toBeUndefined();
	});

	it('refuses a failure with nothing to say', () => {
		expect(parseEvent({ protocol: EMBED_PROTOCOL, type: 'fail' })).toBeUndefined();
		expect(parseEvent({ protocol: EMBED_PROTOCOL, type: 'fail', message: 404 })).toBeUndefined();
	});

	it('ignores the untagged and the unknown', () => {
		expect(parseEvent({ type: 'ready' })).toBeUndefined();
		expect(parseEvent({ protocol: EMBED_PROTOCOL, type: 'pong' })).toBeUndefined();
		expect(parseEvent('ready')).toBeUndefined();
		expect(parseEvent(null)).toBeUndefined();
	});

	it('does not take a command for an event', () => {
		expect(parseEvent(playCommand())).toBeUndefined();
		expect(parseEvent(seekCommand(1))).toBeUndefined();
	});
});

describe('embedFrameUrl', () => {
	it('puts the id in the query and hands back the origin to post to', () => {
		const frame = embedFrameUrl('https://embed.example.org/youtube.html', ID);
		expect(frame).toEqual({
			src: `https://embed.example.org/youtube.html?v=${ID}`,
			origin: 'https://embed.example.org'
		});
	});

	it('keeps the path and the port it was configured with', () => {
		expect(embedFrameUrl('http://localhost:4173/embed/youtube.html', ID)?.src).toBe(
			`http://localhost:4173/embed/youtube.html?v=${ID}`
		);
		expect(embedFrameUrl('http://localhost:4173/embed/youtube.html', ID)?.origin).toBe(
			'http://localhost:4173'
		);
	});

	it('replaces a `v` the configured URL already carried', () => {
		expect(embedFrameUrl(`https://e.example/p.html?v=OTHERIDXXXX&x=1`, ID)?.src).toBe(
			`https://e.example/p.html?v=${ID}&x=1`
		);
	});

	it('refuses an id that is not one, however the caller got it', () => {
		expect(embedFrameUrl('https://e.example/p.html', 'short')).toBeUndefined();
		expect(embedFrameUrl('https://e.example/p.html', '')).toBeUndefined();
		expect(embedFrameUrl('https://e.example/p.html', `${ID}&autoplay=1`)).toBeUndefined();
		expect(embedFrameUrl('https://e.example/p.html', '../../etc/passwd')).toBeUndefined();
	});

	it('refuses a base that is not an http(s) URL', () => {
		expect(embedFrameUrl('', ID)).toBeUndefined();
		expect(embedFrameUrl('embed.example.org/youtube.html', ID)).toBeUndefined();
		expect(embedFrameUrl('javascript:alert(1)', ID)).toBeUndefined();
		expect(embedFrameUrl('tauri://localhost/youtube.html', ID)).toBeUndefined();
	});
});
