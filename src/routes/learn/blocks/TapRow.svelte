<!--
  A wrapping row of tap targets.

  Three types lay their options out as words that flow and wrap — the cloze
  word bank, the word-order bank, the spot-the-error sentence — and each had
  its own copy of the same four declarations with a different gap. One row, one
  gap, so a bank and a sentence read as the same fabric.

  `align: 'end'` bottom-aligns the row, which is what keeps a sentence looking
  like a sentence when only some of its words carry a reading underneath.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		align = 'start',
		role,
		label = '',
		twoUp = false
	}: {
		children: Snippet;
		align?: 'start' | 'end';
		/** `radiogroup` where the row is a one-of-N choice. */
		role?: 'radiogroup';
		/** The row's accessible name — "Available words". */
		label?: string;
		/**
		 * Opt in to a two-column grid once there is room for it (≥48rem)
		 * instead of the default wrapping flow. For a short, fixed set of
		 * full-width options — multiple choice's four cards — never for a bank
		 * of variable-length word tiles, which still wants free flow so a short
		 * word does not stretch to match its row's tallest neighbour.
		 */
		twoUp?: boolean;
	} = $props();
</script>

<div
	class="row"
	class:end={align === 'end'}
	class:two-up={twoUp}
	{role}
	aria-label={label || undefined}
>
	{@render children()}
</div>

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.55rem;
	}

	.row.end {
		align-items: flex-end;
	}

	/*
	  Multiple choice's four full-width cards read as one long stacked column
	  on a phone; once there is room for two side by side, a 2x2 grid scans
	  faster than a taller single file. Grid rather than flex here because
	  `twoUp`'s items are meant to share a width, which flex-wrap alone does
	  not guarantee.
	*/
	@media (min-width: 48rem) {
		.row.two-up {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--gap);
		}
	}
</style>
