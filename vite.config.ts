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
	test: {
		// Pure-logic unit tests: plain `*.test.ts` files under src/ run in node.
		environment: 'node',
		include: ['src/**/*.test.ts'],
		exclude: ['src/**/*.svelte.test.ts']
	}
});
