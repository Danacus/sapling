<script lang="ts">
	const DOORS = [
		{
			title: 'Have a conversation',
			copy: 'Talk through a scene and collect useful words from what you say.',
			href: '/converse',
			kind: 'conversation'
		},
		{
			title: 'Read or watch',
			copy: 'Generate a text, paste your own, or bring subtitles from a video.',
			href: '/read',
			kind: 'read'
		},
		{
			title: 'Ask the assistant',
			copy: 'Add, look up, edit, or organise words in plain language.',
			href: '/chat',
			kind: 'assistant'
		}
	] as const;
</script>

<svelte:head>
	<title>Sapling · Explore</title>
</svelte:head>

<main class="shell shell-broad">
	<header class="page-head ll-rise">
		<p class="eyebrow">Find something new</p>
		<h1>Explore</h1>
		<p>
			Meet your language in context. Words you choose here become part of your garden and return
			when it is time to practise.
		</p>
	</header>

	<div class="doors">
		{#each DOORS as door, index (door.href)}
			<a
				class="card door ll-rise"
				style={`animation-delay: ${100 + index * 60}ms`}
				href={door.href}
			>
				<span class="mark" aria-hidden="true">
					{#if door.kind === 'conversation'}
						<svg viewBox="0 0 24 24"
							><path d="M4.6 6.4h9.6v7.2H8.2l-3.6 3v-3H4.6Z" /><path
								d="M10.6 9.4h8.8v6.2h-2.4v2.6l-3-2.6h-3.4Z"
							/></svg
						>
					{:else if door.kind === 'read'}
						<svg viewBox="0 0 24 24"
							><path d="M12 7.4C9.9 6 7 5.4 3.8 5.6v11.6c3.2-.2 6.1.4 8.2 1.8" /><path
								d="M12 7.4c2.1-1.4 5-2 8.2-1.8v11.6c-3.2-.2-6.1.4-8.2 1.8"
							/><path d="M12 7.4v11.6" /></svg
						>
					{:else}
						<svg viewBox="0 0 24 24"
							><path
								d="M20.3 12.2c0 4-3.7 7.2-8.2 7.2a9.4 9.4 0 0 1-2.5-.3L4.6 20.5l1.3-3.7a6.9 6.9 0 0 1-2.2-4.6C3.7 8.2 7.4 5 11.9 5s8.4 3.2 8.4 7.2Z"
							/><path d="M9 11.9h.01M12 11.9h.01M15 11.9h.01" /></svg
						>
					{/if}
				</span>
				<span class="door-copy">
					<strong>{door.title}</strong>
					<span>{door.copy}</span>
				</span>
				<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"
					><path d="M4.8 12h14" /><path d="m13.4 6.6 5.4 5.4-5.4 5.4" /></svg
				>
			</a>
		{/each}
	</div>
</main>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		gap: clamp(1.5rem, 4vw, 2.5rem);
		padding-block: 2rem 4rem;
	}

	.page-head {
		max-width: 38rem;
	}

	.eyebrow {
		margin: 0 0 0.2rem;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	h1 {
		margin: 0;
		font-size: clamp(2.2rem, 8vw, 3.4rem);
		line-height: 1;
	}

	.page-head > p:last-child {
		margin: 0.75rem 0 0;
		color: var(--text-muted);
		font-size: 1.02rem;
		line-height: 1.55;
	}

	.doors {
		display: grid;
		gap: var(--gap);
	}

	.door {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 1rem;
		max-width: none;
		padding: 1.35rem;
		color: var(--text);
		text-decoration: none;
		transition:
			transform 0.16s ease,
			border-color 0.16s ease,
			box-shadow 0.16s ease;
	}

	.door:hover {
		transform: translateY(-2px);
		border-color: var(--border-strong);
		box-shadow: 0 14px 34px rgb(60 50 20 / 14%);
	}

	.door:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.mark {
		display: grid;
		place-items: center;
		width: 3rem;
		height: 3rem;
		border-radius: var(--radius);
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.mark svg,
	.arrow {
		width: 1.35rem;
		height: 1.35rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.door-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.25rem;
	}

	.door-copy strong {
		font-family: var(--font-display);
		font-size: 1.2rem;
	}

	.door-copy > span {
		color: var(--text-muted);
		line-height: 1.4;
	}

	.arrow {
		color: var(--accent);
	}

	@media (min-width: 48rem) {
		.shell {
			padding-block: 3rem 5rem;
		}

		.doors {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.door {
			grid-template-columns: 1fr auto;
			align-content: start;
			min-height: 14rem;
		}

		.mark {
			grid-column: 1 / -1;
		}

		.door-copy {
			align-self: end;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.door {
			transition: none;
		}
	}
</style>
