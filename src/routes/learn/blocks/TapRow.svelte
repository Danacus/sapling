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
		label = ''
	}: {
		children: Snippet;
		align?: 'start' | 'end';
		/** `radiogroup` where the row is a one-of-N choice. */
		role?: 'radiogroup';
		/** The row's accessible name — "Available words". */
		label?: string;
	} = $props();
</script>

<div class="row" class:end={align === 'end'} {role} aria-label={label || undefined}>
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
</style>
