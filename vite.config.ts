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
		})
	],

	// The README's requirement: the package ships its own `.wasm` and must not be
	// pre-bundled.
	optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },

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
