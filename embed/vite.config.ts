/**
 * The hosted YouTube page's own build — a second, tiny Vite project inside this
 * repo, with nothing of SvelteKit in it.
 *
 * It is separate for one reason: **the page must not ship inside the app.**
 * `static/` is precached by the service worker and copied into the desktop
 * bundle, so a file there would be served from the app's own origin — which is
 * exactly the origin (`tauri://localhost`) the page exists to escape, and the
 * origin holding the learner's database. This page is deliberately frameable by
 * anything, so it is deployed on a throwaway origin of its own (see
 * `.claude/rules/deploy.md`), and `embed/dist/` is what gets uploaded.
 *
 * The `$lib` alias is what keeps it honest: the page imports the *real*
 * `youtubePlayer` and the *real* protocol module out of `src/lib/media/`, so
 * there is one IFrame-API implementation in this repo rather than a copy that
 * drifts. `pnpm check` typechecks this project too (`embed/tsconfig.json`) and
 * CI runs `pnpm embed:build`, so a page that no longer compiles fails a gate
 * rather than a deploy.
 *
 * Paths are derived from `import.meta.url` rather than `__dirname` or a
 * relative `root`: the config has to work whatever directory the build is
 * invoked from, and this project has no `@types/node` to import `node:url`
 * with.
 */

import { defineConfig } from 'vite';

/** This directory, as a plain path — the config's own location, not the caller's. */
const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

export default defineConfig({
	root: here('.'),
	// Relative asset URLs, so the page works at whatever path it is served from.
	base: './',
	resolve: {
		alias: { $lib: here('../src/lib') }
	},
	build: {
		outDir: here('dist'),
		emptyOutDir: true,
		// The one entry. Without this Vite would look for `index.html`, and the
		// deployed URL is `/youtube.html` — named, because an origin serving one
		// page should still say which.
		rollupOptions: { input: here('youtube.html') }
	}
});
