---
paths:
  - "static/**"
  - "src/service-worker.ts"
  - "vite.config.ts"
---

# Deploying

Cloudflare Pages, **git integration**: every push to the connected repo's default branch builds and deploys, site at `*.pages.dev`. CF's build image installs node + pnpm itself (the `packageManager` field in package.json pins the pnpm version via corepack); build command `pnpm build`, output directory `build` — configured once in the CF dashboard, nothing deploy-related lives in the repo.

`static/_headers` sets immutable caching for `/_app/immutable/*`, and sets **no** COOP/COEP — because nothing needs cross-origin isolation, not because it would break anything. That second half corrects an earlier belief (2026-08-29): isolation was thought to break the TTS model-mirror fetches, and measurement says it does not, because those fetches are `cors`-mode against a mirror sending `access-control-allow-origin: *` and COEP only imposes CORP on *no-cors* subresources. Treat isolation as available-if-needed rather than ruled out. `static/_redirects` routes everything else to the `index.html` SPA shell (`fallback: 'index.html'`) *except* `/_app/immutable/*`, which gets a real `static/404.html` on a miss instead — a missing hashed chunk must 404, not silently succeed as HTML, or a single stale-client request for a dead chunk gets edge-cached under the immutable header and poisons that URL for everyone for up to a year (see the incident this fixed, 2026-08-24).

The app is an installable PWA (`static/manifest.webmanifest` + `src/service-worker.ts`; SvelteKit auto-registers the worker in production builds only). Users install it from the browser's "Install app" control, or on iOS via Share → Add to Home Screen.
