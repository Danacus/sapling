<script lang="ts">
	import { browser } from '$app/environment';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';

	import favicon from '$lib/assets/favicon.svg';
	import { getProfile } from '$lib/db';
	import { isSyncEnabled, runSync } from '$lib/sync';
	import { preloadReloadGuard } from '$lib/ui/preload-reload';
	import AppNav from '$lib/ui/AppNav.svelte';
	import { applyTheme, getThemeMode } from '$lib/ui/prefs';
	import Spinner from '$lib/ui/Spinner.svelte';
	import TaskTray from '$lib/ui/TaskTray.svelte';

	import '../app.css';

	let { children } = $props();

	/** Blocks rendering until we know whether onboarding is still required. */
	let checking = $state(browser);

	/**
	 * Full-screen activities keep their own small, explicit way out. The app map
	 * belongs between destinations, not inside a lesson or live conversation.
	 */
	const showAppNav = $derived.by(() => {
		const path = page.url.pathname;
		const immersive =
			path.startsWith('/learn/session') ||
			/^\/read\/[^/]+/.test(path) ||
			/^\/converse\/[^/]+/.test(path);
		const outsideApp =
			path.startsWith('/onboarding') ||
			path.startsWith('/settings') ||
			path.startsWith('/profile') ||
			path.startsWith('/tts-test');
		return !immersive && !outsideApp;
	});

	/** The database could not be opened at all — another tab holds it. */
	let bootError = $state<string | undefined>(undefined);

	/**
	 * One heal-by-reload when a dynamic import fails, and never a loop —
	 * `$lib/ui/preload-reload` carries the whole reasoning and the test.
	 *
	 * All this layer owns is the wiring: the browser's `sessionStorage`, a real
	 * reload, the console, and — the part that makes the guard a guard —
	 * `afterNavigate` as the one thing that re-arms it. This used to clear the
	 * flag as the script ran, which is *before* the failing import is ever
	 * attempted, so a chunk that fails every time reloaded forever.
	 */
	const preloadGuard = browser
		? preloadReloadGuard({
				storage: sessionStorage,
				reload: () => window.location.reload(),
				log: (message) => console.error(message)
			})
		: undefined;

	afterNavigate((navigation) => preloadGuard?.onNavigated(navigation));

	if (browser) {
		window.addEventListener('vite:preloadError', (event) => {
			preloadGuard?.onPreloadError(event.payload);
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
		if (!browser) return;
		const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
		const refreshTheme = () => applyTheme(getThemeMode());
		refreshTheme();
		systemTheme.addEventListener('change', refreshTheme);
		return () => systemTheme.removeEventListener('change', refreshTheme);
	});

	/**
	 * The profile, pulling the log down first if this device has none and is
	 * paired to a library.
	 *
	 * A device that joined an existing library has its profile in the log, not
	 * yet on disk. Sending it to onboarding would have it write a fresh one, and
	 * last-write-wins would then overwrite the real profile on every device.
	 * `runSync` returns its failures, so this costs at most one round trip.
	 */
	async function resolveProfile() {
		const profile = await getProfile();
		if (profile || syncKicked || !isSyncEnabled()) return profile;
		syncKicked = true;
		await runSync();
		return getProfile();
	}

	$effect(() => {
		// Re-runs on every navigation so a missing profile still redirects to
		// onboarding. `checking` deliberately stays an initial-load gate: turning
		// it back on here would unmount the app frame and flash away the persistent
		// navigation while this asynchronous read completes.
		const path = page.url.pathname;
		if (!browser) return;

		let cancelled = false;

		resolveProfile()
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
	<div class="app-frame" class:has-app-nav={showAppNav}>
		{#if showAppNav}<AppNav />{/if}
		<div class="app-content">
			{@render children()}
		</div>
	</div>
	<!-- Mounted once, here, so a job started on one route is still watchable on the next. -->
	<TaskTray />
{/if}

<style>
	/* Only routes on which AppNav actually renders reserve room for its fixed
	   mobile bar. Immersive activities remain true full-screen views. */
	@media (max-width: 47.999rem) {
		.app-frame.has-app-nav .app-content {
			padding-bottom: calc(4.6rem + env(safe-area-inset-bottom));
		}

		/* A collapsed background-task pill floats above the mobile navigation.
		   Its open sheet still owns the bottom edge and covers the navigation. */
		.app-frame.has-app-nav ~ :global(.tray) {
			bottom: calc(5.2rem + env(safe-area-inset-bottom));
		}
	}

	.boot {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: var(--gutter);
		text-align: center;
	}

	/* A centred grid item is shrink-to-fit, so without a cap a long boot error
	   sets itself as one line the width of the window. */
	.boot p {
		max-width: var(--measure);
	}
</style>
