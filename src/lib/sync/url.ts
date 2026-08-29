/**
 * Where the sync Worker lives — a deployment fact, not a learner preference.
 *
 * It has to be a build-time constant rather than a setting, because the module
 * that needs it most is the LiveStore leader worker, and a Web Worker has no
 * `localStorage` to read one from. Vite inlines `import.meta.env` into every
 * bundle it builds, the leader worker's included, so a single `VITE_SYNC_URL`
 * reaches both the window and the worker with nothing passed between them.
 *
 * Set it in Cloudflare Pages' build environment for production, or in a local
 * `.env` for `wrangler dev`. Leaving it unset is a supported configuration and
 * the default one: no URL means no sync backend is ever constructed, and the
 * app is exactly the single-device app it was before.
 */

/** The sync Worker's origin, or `undefined` when this build has no backend. */
export const SYNC_URL: string | undefined =
	(import.meta.env.VITE_SYNC_URL as string | undefined)?.trim() || undefined;
