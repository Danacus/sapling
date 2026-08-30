/**
 * The one place a YouTube link becomes a video id.
 *
 * What the learner has is whatever their browser's address bar or the share
 * sheet handed them, and that is half a dozen shapes for the same eleven
 * characters: `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`, on
 * `www.`, `m.` or `music.`, with a `si=` from the share sheet or a `t=` from
 * "copy at current time", and sometimes with the scheme rubbed off by whatever
 * chat app it travelled through. So the composer does not ask for an id; it
 * takes a link and this decides what it was.
 *
 * Pure and dependency-free, like everything else worth testing in this area —
 * `$lib/db` is not imported here, nothing is fetched, and the answer for a
 * given string never changes. A **bare id** is accepted too: it is the one
 * thing a learner might reasonably paste that is not a URL at all, and eleven
 * characters of the id alphabet cannot be mistaken for anything else.
 *
 * Deliberately strict about the host. An exact match against a small set,
 * never a suffix test: `youtube.com.example.net` ends in nothing this list
 * contains, but a naive `endsWith('youtube.com')` would take it, and the id it
 * yielded would be loaded into an iframe.
 */

/**
 * A video id: exactly eleven characters of YouTube's base64url alphabet.
 *
 * Anchored, because this same pattern is what makes a bare paste recognisable
 * and an unanchored one would happily find eleven characters inside a sentence.
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Every host a YouTube link legitimately arrives on, spelled out in full. */
const HOSTS = new Set([
	'youtube.com',
	'www.youtube.com',
	'm.youtube.com',
	'music.youtube.com',
	'youtube-nocookie.com',
	'www.youtube-nocookie.com',
	'youtu.be',
	'www.youtu.be'
]);

/**
 * The path prefixes that carry the id in the path rather than in `?v=`.
 *
 * `/v/` is the retired flash embed and costs one line to keep accepting.
 */
const PATH_KINDS = new Set(['shorts', 'embed', 'live', 'v']);

/**
 * The video id in `text`, or `undefined` if it does not name one.
 *
 * `undefined` rather than an error: this runs on every keystroke in the
 * composer's link field, where "not a YouTube link yet" is the ordinary state
 * of a box someone is halfway through pasting into.
 */
export function videoIdFrom(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed === '') return undefined;
	if (VIDEO_ID.test(trimmed)) return trimmed;

	// A link copied out of a chat app often lost its scheme; `URL` refuses to
	// parse without one, so the assumption is made here rather than in six
	// regexes. `//` alone is a protocol-relative URL, which `https:` completes.
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
		? trimmed
		: `https://${trimmed.replace(/^\/\//, '')}`;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		return undefined;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	if (!HOSTS.has(url.hostname.toLowerCase())) return undefined;

	// Empty segments dropped, so a trailing or doubled slash is not a segment.
	const parts = url.pathname.split('/').filter(Boolean);

	// `youtu.be/ID` — the whole path is the id.
	if (url.hostname.toLowerCase().endsWith('youtu.be')) return check(parts[0]);

	if (parts[0] === 'watch') return check(url.searchParams.get('v') ?? undefined);
	if (parts.length === 2 && PATH_KINDS.has(parts[0] ?? '')) return check(parts[1]);

	return undefined;
}

/** A candidate is an id only if it is shaped like one — a short one is a typo, not a video. */
function check(candidate: string | undefined): string | undefined {
	return candidate !== undefined && VIDEO_ID.test(candidate) ? candidate : undefined;
}
