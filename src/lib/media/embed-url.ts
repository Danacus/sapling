/**
 * Where the hosted YouTube page lives — a deployment fact, not a preference.
 *
 * The same shape as `$lib/sync/url.ts` and for the same reasons: it is a
 * property of the deployment rather than of the learner, Vite inlines
 * `import.meta.env` into the bundle, and unset is a supported configuration.
 * Set it to the full URL of the deployed page, e.g.
 * `https://embed.example.org/youtube.html`; nothing in the app knows a domain,
 * and the page is deployed from `embed/` to an origin of its own (see
 * `embed-protocol.ts` for why it must not be the app's).
 *
 * **Unset costs the web build nothing** — the browser reaches YouTube directly
 * and never reads this — and costs the desktop build YouTube playback, which
 * `youtube-host.ts` says in the picture's place rather than leaving a frame that
 * never fills.
 */

/** The embed page's URL, or `undefined` when this build has none. */
export const YOUTUBE_EMBED_URL: string | undefined =
	(import.meta.env.VITE_YOUTUBE_EMBED_URL as string | undefined)?.trim() || undefined;
