import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';
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

	resolve: {
		alias: [
			// The OCR worker loads ONNX Runtime's wasm from its CDN rather than our
			// build: the file is 29 MB and Cloudflare Pages refuses anything over
			// 25 MiB. The default `webgpu` export is the bundle that inlines a
			// reference to that file (and Vite would emit it); this is the build
			// that asks `env.wasm.wasmPaths` for it at run time.
			{
				find: /^onnxruntime-web\/webgpu$/,
				replacement: fileURLToPath(
					new URL('./node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', import.meta.url)
				)
			}
		]
	},

	test: {
		// Pure-logic unit tests: plain `*.test.ts` files under src/ run in node.
		//
		// `worker/` is in scope too. It is a second build target with its own
		// tsconfig, but it is the same repo and the same green light: the sync
		// backend derives a room name from a pairing phrase, and that derivation
		// has to keep agreeing with the client's forever, so it needs a test that
		// `pnpm test` actually runs.
		environment: 'node',
		include: ['src/**/*.test.ts', 'worker/**/*.test.ts', 'extension/**/*.test.ts'],
		// The challenge decisions are synchronous calls into the wasm core, which
		// the browser loads before the first page renders; here every file gets
		// it instantiated up front instead.
		setupFiles: ['src/lib/db/wasm.setup.ts'],
		exclude: ['src/**/*.svelte.test.ts']
	}
});
