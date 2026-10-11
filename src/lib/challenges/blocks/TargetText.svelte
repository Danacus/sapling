<!--
  One target-language string, in whichever reading shape the caller has:
  per-token ruby from a local romanizer, or the plain text with its stored
  reading under it. The branch used to be copied into `TapOption` and into
  every prompt; it is one decision now — tokens win where they exist — and the
  leaf is deliberately dumb, because `readingSlot` has already made that
  decision and gated both answers.

  The markup is the exact branch the callers rendered, so DOM and classes are
  unchanged: a `.ruby-text` run, or a bare `<span>` plus an optional `.rom`
  span after it. The inline `.rom` sizing for a `.tap` target stays with
  `TapOption`, which reaches it with `:global`.
-->
<script lang="ts">
	import type { RomanizedToken } from '$lib/romanize';
	import RubyText from '$lib/ui/RubyText.svelte';

	let {
		text,
		reading = '',
		tokens = null
	}: {
		/** The target-language text. */
		text: string;
		/** Its stored Latin reading, already gated by the plan; `''` for none. */
		reading?: string;
		/** Local per-token annotation, or `null` when this language has none. */
		tokens?: RomanizedToken[] | null;
	} = $props();
</script>

{#if tokens && tokens.length > 0}
	<RubyText {tokens} />
{:else}
	<span>{text}</span>
	{#if reading !== ''}<span class="rom">{reading}</span>{/if}
{/if}
