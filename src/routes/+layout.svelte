<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import favicon from '$lib/assets/favicon.svg';
	import { getProfile } from '$lib/db';
	import { runSync } from '$lib/sync/run';
	import Spinner from '$lib/ui/Spinner.svelte';

	import '../app.css';

	let { children } = $props();

	/** Blocks rendering until we know whether onboarding is still required. */
	let checking = $state(browser);

	// Fire-and-forget, once per boot (§9) — not in the `$effect` below, which
	// re-runs on every navigation. The layout instance itself is created once
	// for the life of the app (SvelteKit does not remount it between routes),
	// so this top-level call already is "once on boot"; it must never delay
	// rendering, so it is not awaited and nothing here reads its result. A
	// device picks up what other devices did overnight before the start
	// screen plans a session; `runSync` never throws and no-ops when sync is
	// not configured.
	if (browser) void runSync();

	/**
	 * A tab left open across a deploy keeps running the old build's JS. When it
	 * later dynamically imports one of its own (now-deleted) hashed chunks, the
	 * SPA fallback rewrites the missing path to `index.html` instead of a 404,
	 * and Vite's loader rejects with `vite:preloadError` — this is the "error
	 * loading dynamically imported module" report. Reloading picks up the fresh
	 * shell and heals it, since nothing in this app's state lives past IndexedDB.
	 *
	 * Guarded against looping if the reload lands on a genuinely broken deploy:
	 * this line only runs once a page load has gotten this far successfully, so
	 * it clears any guard a previous reload set, and re-arms for the next one.
	 */
	if (browser) {
		sessionStorage.removeItem('ll.reloadedForPreloadError');
		window.addEventListener('vite:preloadError', () => {
			if (sessionStorage.getItem('ll.reloadedForPreloadError')) return;
			sessionStorage.setItem('ll.reloadedForPreloadError', '1');
			window.location.reload();
		});
	}

	$effect(() => {
		// Re-runs on every navigation: `page.url.pathname` is the tracked read.
		const path = page.url.pathname;
		if (!browser) return;

		let cancelled = false;
		checking = true;

		getProfile()
			.then((profile) => {
				if (cancelled) return;
				if (!profile && !path.startsWith('/onboarding')) {
					// Keep the spinner up; the effect re-runs after the navigation.
					void goto('/onboarding', { replaceState: true });
					return;
				}
				checking = false;
			})
			.catch(() => {
				// A broken/blocked IndexedDB should not leave the app on a spinner.
				if (!cancelled) checking = false;
			});

		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if checking}
	<div class="boot">
		<Spinner />
	</div>
{:else}
	{@render children()}
{/if}

<style>
	.boot {
		display: grid;
		place-items: center;
		min-height: 100dvh;
	}
</style>
