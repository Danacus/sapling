/**
 * Every screen has an in-app way back.
 *
 * The desktop shell (Tauri, WebKitGTK) draws no browser chrome — no back
 * arrow, no address bar, nothing but the page. A route that leaned on the
 * browser's own control stranded the learner there with no way out but
 * quitting the app. So the rule is: every `+page.svelte` renders
 * `$lib/ui/BackLink`, pointed at its logical parent, unless it is on the
 * allowlist below with a reason.
 *
 * This reads the route files as **text** rather than mounting them: the suite
 * is node-environment with no DOM, and what is being checked is a
 * registration — "did someone add a page and forget the way out of it" — which
 * is a fact about the source, not about a rendered tree. Same reasoning as
 * `$lib/challenges/types/registry.test.ts`: a specific gate instead of a
 * silent degradation.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROUTES = dirname(fileURLToPath(import.meta.url));

/**
 * The only screens allowed to have no way back, each with the reason it has
 * nowhere to go. Keep it short: an entry here is a claim that the learner
 * cannot be stranded, not a to-do.
 */
const NO_PARENT: Record<string, string> = {
	'/': 'the dashboard is the root — there is nothing above it',
	'/onboarding':
		'first run, before there is an app to go back to; steps 2+ carry their own in-form Back'
};

/** `src/routes/converse/[id]/+page.svelte` → `/converse/[id]`; the root → `/`. */
function routeOf(file: string): string {
	const dir = relative(ROUTES, dirname(file));
	return dir === '' ? '/' : `/${dir.split(sep).join('/')}`;
}

/** Every `.svelte` file under `src/routes`, deepest last, in a stable order. */
function svelteFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name)
	)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...svelteFiles(path));
		else if (entry.name.endsWith('.svelte')) found.push(path);
	}
	return found;
}

const sources = svelteFiles(ROUTES).map((path) => ({
	/** `src/routes`-relative, for messages about files that are not pages. */
	rel: relative(ROUTES, path).split(sep).join('/'),
	route: routeOf(path),
	isPage: path.endsWith(`${sep}+page.svelte`),
	source: readFileSync(path, 'utf8')
}));

const pages = sources.filter((file) => file.isPage);

describe('every screen has a way back', () => {
	it('finds the route pages at all', () => {
		// A broken walk would make every assertion below vacuously true.
		expect(pages.length).toBeGreaterThan(5);
		expect(pages.map((page) => page.route)).toContain('/learn');
	});

	it('every route page renders BackLink, or is a listed exception', () => {
		const missing = pages
			.filter((page) => !page.source.includes('$lib/ui/BackLink.svelte'))
			.filter((page) => !(page.route in NO_PARENT))
			.map(
				(page) =>
					`${page.route}: add \`import BackLink from '$lib/ui/BackLink.svelte'\` and render ` +
					`<BackLink href="/its-parent" label="Back to …" /> in its topbar — or add it to ` +
					`NO_PARENT in src/routes/back-link.test.ts with the reason it cannot strand anyone`
			);

		expect(missing).toEqual([]);
	});

	it('lists no exception that is not a real route', () => {
		const routes = new Set(pages.map((page) => page.route));
		const stale = Object.keys(NO_PARENT)
			.filter((route) => !routes.has(route))
			.map((route) => `${route}: no such page — drop it from NO_PARENT`);

		expect(stale).toEqual([]);
	});

	it('lists no exception that has since grown a way back', () => {
		const redundant = pages
			.filter((page) => page.route in NO_PARENT)
			.filter((page) => page.source.includes('$lib/ui/BackLink.svelte'))
			.map((page) => `${page.route}: now has a BackLink — drop its NO_PARENT entry`);

		expect(redundant).toEqual([]);
	});

	it('never navigates back through history', () => {
		// A deep link, a reload or a fresh desktop window has no history to go
		// back to. Every way back is a hardcoded parent href instead.
		const offenders = sources
			.filter((file) => /history\s*\.\s*back\s*\(/.test(file.source))
			.map(
				(file) =>
					`${file.rel}: use <BackLink href="/its-parent" …/>, not history.back() — ` +
					`a deep-linked or reloaded page has no history`
			);

		expect(offenders).toEqual([]);
	});

	it('has no page-local copy of the back control left', () => {
		// The nine routes that each owned an inline chevron and its own copy of
		// the same 2.25rem squircle are the reason BackLink exists.
		const offenders = sources
			.filter((file) => file.source.includes('class="back"'))
			.map((file) => `${file.rel}: replace the inline <a class="back"> with <BackLink />`);

		expect(offenders).toEqual([]);
	});
});
