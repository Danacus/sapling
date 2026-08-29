---
paths:
  - "static/**"
  - "src/service-worker.ts"
  - "vite.config.ts"
  - "worker/**"
  - "wrangler.jsonc"
---

# Deploying

**Two targets, deployed separately on purpose.** The app is Cloudflare Pages (below). The sync backend is a *Worker* — `worker/`, `wrangler.jsonc` — deployed either by **Workers Builds** (the Workers equivalent of Pages' git integration: connect the repo under the Worker's Settings → Builds, deploy command `npx wrangler deploy`, and the Worker's name must match `wrangler.jsonc`'s `sapling-sync` or the build fails) or by hand with `pnpm sync:deploy`.

**If you set Workers Builds *build watch paths*, they must include `src/lib/sync/*`, not just `worker/*`.** The Worker imports `src/lib/sync/phrase.ts` from the client on purpose — the client mints the pairing phrase and the Worker hashes it, so a normalisation that differed by one character would compute a different room. Watch paths scoped to `worker/` alone would ship a new client against a stale Worker, and the symptom is a second device opening an empty library, which reads as lost data rather than as a version skew. Leaving watch paths empty (rebuild on every push) is the safe default. Keeping them apart leaves `static/_headers` and `static/_redirects` — and the two caching incidents they encode — untouched, at the cost of a cross-origin WebSocket, which needs no CORS and carries no cookies. The app finds the Worker through `VITE_SYNC_URL`, a build-time variable set in the Pages project's environment; unset, the build simply has no sync. `pnpm check` typechecks the Worker too (`tsc -p worker`), since svelte-check's tsconfig only covers `src/**`. See `docs/livestore-sync.md`.

Cloudflare Pages, **git integration**: every push to the connected repo's default branch builds and deploys, site at `*.pages.dev`. CF's build image installs node + pnpm itself (the `packageManager` field in package.json pins the pnpm version via corepack); build command `pnpm build`, output directory `build` — configured once in the CF dashboard, nothing deploy-related lives in the repo.

`static/_headers` sets immutable caching for `/_app/immutable/*`, and sets **no** COOP/COEP — because nothing needs cross-origin isolation, not because it would break anything. That second half corrects an earlier belief (2026-08-29): isolation was thought to break the TTS model-mirror fetches, and measurement says it does not, because those fetches are `cors`-mode against a mirror sending `access-control-allow-origin: *` and COEP only imposes CORP on *no-cors* subresources. Treat isolation as available-if-needed rather than ruled out. `static/_redirects` routes everything else to the `index.html` SPA shell (`fallback: 'index.html'`) *except* `/_app/immutable/*`, which gets a real `static/404.html` on a miss instead — a missing hashed chunk must 404, not silently succeed as HTML, or a single stale-client request for a dead chunk gets edge-cached under the immutable header and poisons that URL for everyone for up to a year (see the incident this fixed, 2026-08-24).

The app is an installable PWA (`static/manifest.webmanifest` + `src/service-worker.ts`; SvelteKit auto-registers the worker in production builds only). Users install it from the browser's "Install app" control, or on iOS via Share → Add to Home Screen.
