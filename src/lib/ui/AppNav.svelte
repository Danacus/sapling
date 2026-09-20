<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { listProfiles, setActiveProfile } from '$lib/db';
	import type { LanguageProfile } from '$lib/db';

	type Destination = 'today' | 'practice' | 'explore' | 'garden';

	interface NavItem {
		id: Destination;
		label: string;
		href: string;
	}

	const ITEMS: NavItem[] = [
		{ id: 'today', label: 'Today', href: '/' },
		{ id: 'practice', label: 'Practice', href: '/learn' },
		{ id: 'explore', label: 'Explore', href: '/explore' },
		{ id: 'garden', label: 'Garden', href: '/words' }
	];

	const path = $derived(page.url.pathname);
	let profiles = $state<LanguageProfile[]>([]);
	let switchingProfile = $state(false);
	let menuView = $state<'root' | 'languages'>('root');
	let menu = $state<HTMLDetailsElement | null>(null);
	const activeProfile = $derived(profiles.find((entry) => entry.active));

	$effect(() => {
		if (!browser) return;
		let cancelled = false;
		listProfiles().then((loaded) => {
			if (!cancelled) profiles = loaded;
		});
		return () => {
			cancelled = true;
		};
	});

	async function switchProfile(id: string) {
		if (!id || profiles.find((entry) => entry.id === id)?.active) return;
		switchingProfile = true;
		try {
			await setActiveProfile(id);
			window.location.assign('/');
		} catch {
			switchingProfile = false;
		}
	}

	function resetClosedMenu() {
		if (!menu?.open) menuView = 'root';
	}

	const active = $derived.by((): Destination | undefined => {
		if (path === '/' || path.startsWith('/activity')) return 'today';
		if (path.startsWith('/learn')) return 'practice';
		if (
			path.startsWith('/explore') ||
			path.startsWith('/read') ||
			path.startsWith('/converse') ||
			path.startsWith('/chat')
		)
			return 'explore';
		if (path.startsWith('/words')) return 'garden';
		return undefined;
	});
</script>

<nav class="app-nav" aria-label="Main navigation">
	<div class="nav-inner">
		<a class="brand" href="/" aria-label="Sapling home">
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d="M12 21v-8.6" />
				<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
				<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
			</svg>
			<span>Sapling</span>
		</a>

		<div class="destinations">
			{#each ITEMS as item (item.id)}
				<a
					class="destination"
					class:active={active === item.id}
					href={item.href}
					aria-current={active === item.id ? 'page' : undefined}
				>
					<span class="nav-icon" aria-hidden="true">
						{#if item.id === 'today'}
							<svg viewBox="0 0 24 24"
								><path d="M4.5 11.2 12 5l7.5 6.2" /><path d="M6.7 10v9h10.6v-9" /></svg
							>
						{:else if item.id === 'practice'}
							<svg viewBox="0 0 24 24"
								><path d="M6.2 5.2h11.6v13.6H6.2z" /><path d="M9 9h6M9 12.2h6M9 15.4h3.4" /></svg
							>
						{:else if item.id === 'explore'}
							<svg viewBox="0 0 24 24"
								><circle cx="12" cy="12" r="8.2" /><path
									d="m14.8 9.2-1.7 3.9-3.9 1.7 1.7-3.9 3.9-1.7Z"
								/></svg
							>
						{:else}
							<svg viewBox="0 0 24 24"
								><path d="M12 21v-8.6" /><path
									d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z"
								/><path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" /></svg
							>
						{/if}
					</span>
					<span>{item.label}</span>
				</a>
			{/each}
		</div>

		<div class="utilities">
			<details class="utility-menu" bind:this={menu} ontoggle={resetClosedMenu}>
				<summary class="utility-trigger" aria-label="Profile and settings">
					<span class="nav-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24">
							<circle cx="12" cy="12" r="1" />
							<circle cx="5.5" cy="12" r="1" />
							<circle cx="18.5" cy="12" r="1" />
						</svg>
					</span>
					<span>More</span>
				</summary>
				<div class="utility-panel">
					{#key menuView}
						<div class="panel-view" class:picker-enter={menuView === 'languages'}>
							{#if menuView === 'root'}
								<div class="panel-heading">
									<p>Your Sapling</p>
									<strong>More</strong>
								</div>
								<button
									type="button"
									class="menu-row garden-row"
									onclick={() => (menuView = 'languages')}
								>
									<span class="language-initial" aria-hidden="true"
										>{activeProfile?.targetLanguage.trim().charAt(0).toLocaleUpperCase() ||
											'·'}</span
									>
									<span class="row-copy"
										><small>Language garden</small><strong
											>{activeProfile?.targetLanguage || 'Choose a language'}</strong
										></span
									>
									<svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"
										><path d="m9 6 6 6-6 6" /></svg
									>
								</button>
								<div class="menu-divider"></div>
								<a class="menu-row" href="/profile">
									<svg viewBox="0 0 24 24" aria-hidden="true">
										<circle cx="12" cy="8.4" r="3.4" />
										<path d="M4.9 19.6c.7-3.4 3.5-5.5 7.1-5.5s6.4 2.1 7.1 5.5" />
									</svg>
									<span>Profile</span>
								</a>
								<a class="menu-row" href="/settings">
									<svg viewBox="0 0 24 24" aria-hidden="true">
										<path d="M4 8.2h8.4M17.4 8.2H20M4 15.8h2.6M11.6 15.8H20" />
										<circle cx="15" cy="8.2" r="2.3" />
										<circle cx="9" cy="15.8" r="2.3" />
									</svg>
									<span>Settings</span>
								</a>
							{:else}
								<div class="picker-heading">
									<button
										type="button"
										class="back-button"
										onclick={() => (menuView = 'root')}
										aria-label="Back to More">←</button
									>
									<div>
										<p>Your gardens</p>
										<strong>Choose a language</strong>
									</div>
								</div>
								<div class="language-list">
									{#each profiles as entry (entry.id)}
										<button
											type="button"
											class="menu-row language-row"
											class:active={entry.active}
											disabled={entry.active || switchingProfile}
											onclick={() => void switchProfile(entry.id)}
										>
											<span class="language-initial" aria-hidden="true"
												>{entry.targetLanguage.trim().charAt(0).toLocaleUpperCase()}</span
											>
											<span class="row-copy"
												><strong>{entry.targetLanguage}</strong><small
													>from {entry.nativeLanguage}</small
												></span
											>
											{#if entry.active}<span class="check" aria-hidden="true">✓</span>{/if}
										</button>
									{/each}
								</div>
								<a class="menu-row add-language" href="/onboarding?add=1"
									><span class="add" aria-hidden="true">+</span><span>Add another language</span></a
								>
							{/if}
						</div>
					{/key}
				</div>
			</details>
		</div>
	</div>
</nav>

<style>
	.app-nav {
		position: fixed;
		/* Below the global task tray and modal sheets, above ordinary route UI. */
		z-index: 20;
		inset: auto 0 0;
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface) 94%, transparent);
		box-shadow: 0 -8px 24px rgb(38 48 31 / 8%);
		backdrop-filter: blur(14px);
	}

	.nav-inner {
		display: grid;
		grid-template-columns: minmax(0, 4fr) minmax(0, 1fr);
		width: 100%;
		max-width: var(--measure-full);
		margin-inline: auto;
		padding: 0.35rem max(var(--gutter), env(safe-area-inset-right))
			calc(0.35rem + env(safe-area-inset-bottom)) max(var(--gutter), env(safe-area-inset-left));
	}

	.brand {
		display: none;
	}

	.destinations {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.2rem;
	}

	.utilities {
		position: relative;
		min-width: 0;
	}

	.utility-menu,
	.utility-trigger {
		height: 100%;
	}

	.utility-trigger {
		display: flex;
		min-height: 3.6rem;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: 0.15rem;
		border-radius: var(--radius);
		color: var(--text-muted);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.01em;
		cursor: pointer;
		list-style: none;
	}

	.utility-trigger::-webkit-details-marker {
		display: none;
	}

	.utility-trigger:hover,
	.utility-menu[open] .utility-trigger {
		background: var(--surface-alt);
		color: var(--text);
	}

	.utility-panel {
		position: fixed;
		z-index: 2;
		inset: auto 0.75rem calc(4.65rem + env(safe-area-inset-bottom));
		max-height: min(31rem, calc(100dvh - 6.5rem));
		overflow: hidden auto;
		padding: 0.7rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: 0 18px 50px rgb(38 48 31 / 24%);
	}

	.utility-menu[open] .utility-panel {
		transform-origin: bottom right;
		animation: menu-open 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
	}

	.panel-view {
		animation: view-from-left 170ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
	}

	.panel-view.picker-enter {
		animation-name: view-from-right;
	}

	@keyframes menu-open {
		from {
			opacity: 0;
			transform: translateY(0.65rem) scale(0.97);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	@keyframes view-from-right {
		from {
			opacity: 0;
			transform: translateX(0.8rem);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@keyframes view-from-left {
		from {
			opacity: 0;
			transform: translateX(-0.8rem);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}

	.panel-heading,
	.picker-heading {
		padding: 0.25rem 0.4rem 0.7rem;
	}

	.panel-heading p,
	.picker-heading p {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.65rem;
		font-weight: 750;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.panel-heading strong,
	.picker-heading strong {
		font-family: var(--font-display);
		font-size: 1.15rem;
	}

	.menu-row {
		display: flex;
		align-items: center;
		width: 100%;
		gap: 0.65rem;
		padding: 0.65rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 700;
		text-align: left;
		text-decoration: none;
		cursor: pointer;
	}

	.menu-row:hover:not(:disabled) {
		background: var(--surface-alt);
	}

	.menu-row > svg {
		width: 1.15rem;
		height: 1.15rem;
		flex: 0 0 auto;
		color: var(--text-muted);
	}

	.garden-row {
		padding-block: 0.75rem;
		background: color-mix(in srgb, var(--primary-soft) 55%, transparent);
	}

	.garden-row .chevron {
		margin-left: auto;
	}

	.menu-divider {
		height: 1px;
		margin: 0.45rem 0.35rem;
		background: var(--border);
	}

	.language-initial,
	.add {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		flex: 0 0 auto;
		border: 1px solid var(--border);
		border-radius: 50%;
		background: var(--surface);
		color: var(--primary-strong);
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 800;
	}

	.row-copy {
		display: flex;
		min-width: 0;
		flex: 1;
		flex-direction: column;
		line-height: 1.2;
	}

	.row-copy small {
		color: var(--text-muted);
		font-size: 0.72rem;
		font-weight: 600;
	}

	.picker-heading {
		display: flex;
		align-items: center;
		gap: 0.65rem;
	}

	.back-button {
		display: grid;
		place-items: center;
		width: 2.3rem;
		height: 2.3rem;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
		color: var(--text);
		font: inherit;
		font-size: 1.05rem;
		cursor: pointer;
	}

	.language-row.active {
		background: color-mix(in srgb, var(--primary-soft) 65%, transparent);
		opacity: 1;
	}

	.language-row:disabled {
		cursor: default;
	}

	.check {
		color: var(--primary-strong);
		font-weight: 900;
	}

	.add-language {
		margin-top: 0.4rem;
		border-top: 1px dashed var(--border);
		border-radius: 0 0 var(--radius-sm) var(--radius-sm);
		color: var(--primary-strong);
	}

	.add {
		border-radius: var(--radius-sm);
		background: transparent;
	}

	.destination {
		display: flex;
		min-width: 0;
		min-height: 3.6rem;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: 0.15rem;
		border-radius: var(--radius);
		color: var(--text-muted);
		font-size: 0.69rem;
		font-weight: 700;
		letter-spacing: 0.01em;
		text-decoration: none;
	}

	.destination.active {
		background: color-mix(in srgb, var(--primary-soft) 70%, transparent);
		color: var(--primary-strong);
	}

	.destination:focus-visible,
	.brand:focus-visible,
	.utility-trigger:focus-visible,
	.menu-row:focus-visible,
	.back-button:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.nav-icon {
		display: grid;
		place-items: center;
		width: 1.35rem;
		height: 1.35rem;
	}

	svg {
		width: 100%;
		height: 100%;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	@media (min-width: 48rem) {
		.app-nav {
			position: sticky;
			inset: 0 0 auto;
			border-top: 0;
			border-bottom: 1px solid var(--border);
			box-shadow: 0 6px 24px rgb(38 48 31 / 5%);
		}

		.nav-inner {
			display: grid;
			grid-template-columns: minmax(8rem, 1fr) auto minmax(8rem, 1fr);
			align-items: center;
			gap: 1rem;
			padding-block: 0.55rem;
		}

		.brand {
			display: inline-flex;
			width: fit-content;
			align-items: center;
			gap: 0.45rem;
			color: var(--text);
			font-family: var(--font-display);
			font-size: 1.05rem;
			font-weight: 700;
			text-decoration: none;
		}

		.brand svg {
			width: 1.35rem;
			height: 1.35rem;
			color: var(--primary);
		}

		.destinations {
			display: flex;
			padding: 0.2rem;
			border: 1px solid var(--border);
			border-radius: calc(var(--radius) + 2px);
			background: color-mix(in srgb, var(--bg) 65%, var(--surface));
		}

		.destination {
			min-height: 2.35rem;
			padding: 0.25rem 0.8rem;
			flex-direction: row;
			gap: 0.4rem;
			font-size: 0.82rem;
		}

		.nav-icon {
			width: 1rem;
			height: 1rem;
		}

		.utilities {
			display: block;
			justify-self: end;
		}

		.utility-trigger {
			min-height: 2.35rem;
			padding: 0.25rem 0.7rem;
			flex-direction: row;
			gap: 0.4rem;
			border-radius: var(--radius-sm);
			font-size: 0.78rem;
		}

		.utility-trigger .nav-icon {
			width: 1rem;
			height: 1rem;
		}

		.utility-panel {
			position: absolute;
			top: calc(100% + 0.7rem);
			right: 0;
			bottom: auto;
			left: auto;
			width: 19rem;
			max-height: min(31rem, calc(100dvh - 5.5rem));
		}

		.utility-menu[open] .utility-panel {
			transform-origin: top right;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.utility-menu[open] .utility-panel,
		.panel-view,
		.panel-view.picker-enter {
			animation: none;
		}
	}
</style>
