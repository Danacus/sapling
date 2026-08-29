<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import favicon from '$lib/assets/favicon.svg';
	import { getProfile } from '$lib/db';
	import { storeReady } from '$lib/livestore/store';
	import Spinner from '$lib/ui/Spinner.svelte';

	import '../app.css';

	let { children } = $props();

	/** Blocks rendering until we know whether onboarding is still required. */
	let checking = $state(browser);

	// Boot the data layer here rather than on first use, and deliberately so.
	// The service worker adopts `/_app/immutable/**` into its cache on first
	// *fetch*, so a learner who installs the PWA, never opens a lesson and then
	// goes offline would otherwise have no cached leader worker — and therefore
	// no database at all — on the next launch. Booting from the layout means
	// every route pays for it once and offline never depends on which screens
	// the learner happened to visit. Idempotent, and every repository call
	// awaits the same promise.
	if (browser) void storeReady();

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
