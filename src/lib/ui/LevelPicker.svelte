<!--
  The four starting levels, as a grid of cards.

  Onboarding asks this once and the profile screen asks it again, and the two
  carried the same list, the same markup and the same ~70 lines of card styling
  in parallel — so a fifth level, or a reworded blurb, was two edits that
  nothing tied together.

  `level` is bindable and may be `undefined`: onboarding starts with nothing
  chosen, which is what its "continue" gate reads.
-->
<script lang="ts">
	import type { Level } from '$lib/types';

	let { level = $bindable() }: { level: Level | undefined } = $props();

	const LEVELS: { value: Level; emoji: string; title: string; blurb: string }[] = [
		{ value: 'beginner', emoji: '🌱', title: 'Beginner', blurb: 'Starting from zero' },
		{ value: 'elementary', emoji: '🌿', title: 'Elementary', blurb: 'Know a few basics' },
		{ value: 'intermediate', emoji: '🌳', title: 'Intermediate', blurb: 'Can hold a chat' },
		{ value: 'advanced', emoji: '🏔️', title: 'Advanced', blurb: 'Polishing the details' }
	];
</script>

<div class="levels">
	{#each LEVELS as option (option.value)}
		<button
			type="button"
			class="level"
			class:selected={level === option.value}
			aria-pressed={level === option.value}
			onclick={() => (level = option.value)}
		>
			<span class="level-emoji" aria-hidden="true">{option.emoji}</span>
			<span class="level-title">{option.title}</span>
			<span class="level-blurb">{option.blurb}</span>
		</button>
	{/each}
</div>

<style>
	.levels {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}

	.level {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.85rem 0.9rem;
		border: 1.5px solid var(--border);
		border-bottom-width: 3px;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			transform 0.08s ease;
	}

	.level:hover {
		border-color: var(--border-strong);
	}

	.level:active {
		transform: translateY(1px);
		border-bottom-width: 1.5px;
	}

	.level.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.level:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.level-emoji {
		font-size: 1.25rem;
		line-height: 1.2;
	}

	.level-title {
		font-family: var(--font-display);
		font-size: 1.02rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
	}

	.level-blurb {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	@media (max-width: 420px) {
		.levels {
			grid-template-columns: 1fr;
		}
	}
</style>
