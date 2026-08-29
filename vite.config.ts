import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Fully client-side SPA: every route falls back to index.html and is
			// rendered in the browser (see src/routes/+layout.ts).
			adapter: adapter({
				fallback: 'index.html'
			})
		}),
		{
			// A `?worker` import is a *separate* Rollup build, and SvelteKit gives
			// it its own asset directory *and* its own naming pattern
			// (`workers/assets/[name]-[hash]` vs `assets/[name].[hash]`). An asset
			// both graphs need is therefore emitted twice under two URLs — for
			// LiveStore that is `wa-sqlite.wasm`, ~605KB downloaded and compiled
			// twice, since the client session runs SQLite on the window thread as
			// well as in the leader worker. The hashes already match; only the
			// patterns differ, so aligning them makes the second emit land on the
			// first with identical bytes.
			//
			// This has to run *after* the SvelteKit plugin: SvelteKit sets the
			// pattern from its own `config` hook, so setting `worker.rollupOptions`
			// at the top level of this file is silently overridden.
			name: 'sapling-dedupe-worker-assets',
			config: () => ({
				worker: {
					rollupOptions: {
						output: { assetFileNames: '_app/immutable/assets/[name].[hash][extname]' }
					}
				}
			})
		}
	],

	test: {
		// Pure-logic unit tests: plain `*.test.ts` files under src/ run in node.
		//
		// `worker/` is in scope too. It is a second build target with its own
		// tsconfig, but it is the same repo and the same green light: the sync
		// backend derives a room name from a pairing phrase, and that derivation
		// has to keep agreeing with the client's forever, so it needs a test that
		// `pnpm test` actually runs.
		environment: 'node',
		include: ['src/**/*.test.ts', 'worker/**/*.test.ts'],
		exclude: ['src/**/*.svelte.test.ts']
	}
});
