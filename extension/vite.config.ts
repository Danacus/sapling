/**
 * The companion extension's build, a third small Vite project beside the app
 * and `embed/`. Each script is built on its own as one IIFE file, because a
 * content script and an injected script cannot be modules or share a chunk —
 * so `pnpm extension:build` runs this once per entry, named by
 * `SAPLING_EXTENSION_ENTRY`, and the background run writes the manifest.
 *
 * The app's origins are the deployed app and the dev server. `$lib` is the app's own source,
 * so the tokenizer, the romanizer and the bridge protocol are the app's, not
 * copies.
 */

import { defineConfig, loadEnv, type Plugin } from 'vite';

const here = (path: string) => decodeURIComponent(new URL(path, import.meta.url).pathname);

const ENTRIES = ['background', 'bridge', 'page'] as const;
type Entry = (typeof ENTRIES)[number];

const ORIGINS = ['https://sapling.vanoverloop.xyz', 'http://localhost:5173'];

function manifest(origins: string[]): Plugin {
	// Firefox matches no URL against a pattern with a port, so match the host and
	// let the scripts check the exact origin.
	const matches = [
		...new Set(
			origins.map((origin) => `${new URL(origin).protocol}//${new URL(origin).hostname}/*`)
		)
	];
	return {
		name: 'sapling-extension-manifest',
		generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: 'manifest.json',
				source: JSON.stringify(
					{
						manifest_version: 3,
						name: 'Sapling',
						version: '0.1.0',
						description: 'Underlines the words you are learning in Sapling and collects new ones.',
						icons: { '192': 'icon-192.png' },
						browser_specific_settings: {
							gecko: {
								id: 'companion@sapling.vanoverloop.xyz',
								strict_min_version: '140.0',
								data_collection_permissions: { required: ['none'] }
							}
						},
						background: { scripts: ['background.js'] },
						action: {
							default_title: 'Underline your Sapling words on this page',
							default_icon: { '192': 'icon-192.png' }
						},
						permissions: ['storage', 'activeTab', 'scripting'],
						host_permissions: matches,
						content_scripts: [{ matches, js: ['bridge.js'], run_at: 'document_start' }]
					},
					null,
					'\t'
				)
			});
		}
	};
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, here('..'), ['SAPLING_EXTENSION_']);
	const entry = (env.SAPLING_EXTENSION_ENTRY ?? 'background') as Entry;
	if (!ENTRIES.includes(entry)) throw new Error(`Unknown extension entry: ${entry}`);
	const origins = ORIGINS;

	return {
		root: here('.'),
		envDir: here('..'),
		// Only the background run copies the icon and the highlight styles.
		publicDir: entry === 'background' ? here('public') : false,
		resolve: { alias: { $lib: here('../src/lib') } },
		define: { __SAPLING_ORIGINS__: JSON.stringify(origins) },
		plugins: entry === 'background' ? [manifest(origins)] : [],
		build: {
			outDir: here('dist'),
			// Only the first run of `extension:build` empties the directory; the watcher never does.
			emptyOutDir: entry === 'background' && mode === 'production',
			minify: false,
			modulePreload: false,
			rollupOptions: {
				input: here(`${entry}.ts`),
				// Vite's preload helper reads `import.meta`, emptied in an IIFE; it only wraps the inlined romanizer.
				onLog(level, log, handler) {
					if (log.code !== 'EMPTY_IMPORT_META') handler(level, log);
				},
				output: {
					format: 'iife',
					entryFileNames: `${entry}.js`
				}
			}
		}
	};
});
