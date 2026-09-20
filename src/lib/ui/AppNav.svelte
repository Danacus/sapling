<script lang="ts">
	import { page } from '$app/state';

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
			<a href="/profile">Profile</a>
			<a href="/settings">Settings</a>
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
		width: 100%;
		max-width: var(--measure-full);
		margin-inline: auto;
		padding: 0.35rem max(var(--gutter), env(safe-area-inset-right))
			calc(0.35rem + env(safe-area-inset-bottom)) max(var(--gutter), env(safe-area-inset-left));
	}

	.brand,
	.utilities {
		display: none;
	}

	.destinations {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.2rem;
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
	.utilities a:focus-visible {
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
			display: flex;
			justify-content: flex-end;
			gap: 0.35rem;
		}

		.utilities a {
			padding: 0.45rem 0.55rem;
			border-radius: var(--radius-sm);
			color: var(--text-muted);
			font-size: 0.78rem;
			font-weight: 700;
			text-decoration: none;
		}

		.utilities a:hover {
			background: var(--surface-alt);
			color: var(--text);
		}
	}
</style>
