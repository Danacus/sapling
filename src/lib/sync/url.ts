/**
 * Where the sync Worker lives — a deployment fact, not a learner preference.
 *
 * It has to be a build-time constant rather than a setting: it is a property of
 * the deployment, not of the learner, and Vite inlines `import.meta.env` into
 * every bundle it builds, so one `VITE_SYNC_URL` reaches every module that
 * needs it with nothing passed between them.
 *
 * Set it in Cloudflare Pages' build environment for production, or in a local
 * `.env` for `wrangler dev`. Leaving it unset is a supported configuration and
 * the default one: no URL means no sync backend is ever constructed, and the
 * app is exactly the single-device app it was before.
 */

/** The sync Worker's origin, or `undefined` when this build has no backend. */
export const SYNC_URL: string | undefined =
	(import.meta.env.VITE_SYNC_URL as string | undefined)?.trim() || undefined;
