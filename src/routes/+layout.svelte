<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import favicon from '$lib/assets/favicon.svg';
	import { getProfile } from '$lib/db';
	import { runSync } from '$lib/sync/run';

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
	<div class="boot" role="status" aria-label="Loading">
		<div class="spinner"></div>
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

	.spinner {
		width: 2.5rem;
		height: 2.5rem;
		border: 4px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
</style>
