<!--
  The bank of words a challenge offers to be tapped: a quiet label, the stitched
  hairline that closes every list on the paper, and the wrapping row itself.

  Cloze and word-order both draw one, and both carried their own byte-identical
  copy of the label and spacing — the exact drift `TapRow`/`TapOption` were
  extracted to stop, one level up. The bank is a skin, so it lives here rather
  than in two scoped style blocks that only look the same until someone edits
  one of them.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	import TapRow from './TapRow.svelte';

	let {
		children,
		title = 'Word bank',
		label = ''
	}: {
		children: Snippet;
		/** The heading over the bank. */
		title?: string;
		/** The row's accessible name — "Available words". */
		label?: string;
	} = $props();
</script>

<div class="bank">
	<p class="bank-label">{title}</p>
	<hr class="stitch" />
	<TapRow {label}>
		{@render children()}
	</TapRow>
</div>

<style>
	.bank {
		margin-bottom: 1.5rem;
	}

	/* The bank is a list of material, so it opens like every other list on the
	   paper: a quiet label closed with the stitched hairline. */
	.bank-label {
		margin: 0;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.bank-label + .stitch {
		margin: 0.35rem 0 0.8rem;
	}
</style>
