<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import favicon from '$lib/assets/favicon.svg';
	import { getProfile } from '$lib/db';
	import { runSync } from '$lib/sync';
	import Spinner from '$lib/ui/Spinner.svelte';

	import '../app.css';

	let { children } = $props();

	/** Blocks rendering until we know whether onboarding is still required. */
	let checking = $state(browser);

	/** The database could not be opened at all — another tab holds it. */
	let bootError = $state<string | undefined>(undefined);

	/**
	 * A tab left open across a deploy keeps running the old build's JS. When it
	 * later dynamically imports one of its own (now-deleted) hashed chunks, the
	 * SPA fallback rewrites the missing path to `index.html` instead of a 404,
	 * and Vite's loader rejects with `vite:preloadError` — this is the "error
	 * loading dynamically imported module" report. Reloading picks up the fresh
	 * shell and heals it, since nothing in this app's state lives past the local database.
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

		// Coming back to the tab is the one moment worth spending a sync on: the
		// device has probably been away, and another one has probably written.
		// There is nothing periodic — `runSync` no-ops when sync is off.
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') void runSync();
		});
	}

	/** Boot sync fires once, not on every navigation the effect below re-runs on. */
	let syncKicked = false;

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
				// Fire-and-forget, strictly after the render gate: sync must never
				// be something the app waits on.
				if (!syncKicked) {
					syncKicked = true;
					void runSync();
				}
			})
			.catch((error: unknown) => {
				// A database that will not open must not leave the app on a spinner.
				if (cancelled) return;
				bootError = error instanceof Error ? error.message : 'The database could not be opened.';
				checking = false;
			});

		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if bootError}
	<div class="boot">
		<p>{bootError}</p>
	</div>
{:else if checking}
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
		padding: var(--gutter);
		text-align: center;
	}
</style>
