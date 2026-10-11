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

	/*
	  No wide-screen rule, deliberately. The learn route keeps the reading
	  measure, so at ≥48rem the row is *narrower* than on a phone, not wider —
	  folding multiple choice's four cards into a 2x2 grid there gave each one
	  about half a phone's width and stretched a one-line option to the height
	  of its three-line neighbour. A single file at every width is the trade.
	*/
</style>
