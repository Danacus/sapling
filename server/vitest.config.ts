import { defineConfig } from 'vitest/config';

// The server's own vitest, separate from the app's (which lives inline in the
// repo-root vite.config.ts and only ever globs `src/**` at the root). Tests are
// pure node: an in-memory SQLite store and `app.request()`, no listening socket.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
});
