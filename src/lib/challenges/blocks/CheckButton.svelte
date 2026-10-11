<!--
  The commit button at the foot of a challenge.

  Six identical copies of one `class` attribute and one label, differing only
  in whether the type submits a form (cloze, word order) or handles a click
  (the rest). `margin-top: auto` — from `.check` in app.css — is the load-
  bearing part: it pins the button to the bottom of the challenge column
  however tall the content above it turns out to be, so the button never moves
  between challenge types.
-->
<script lang="ts">
	let {
		disabled = false,
		label = 'Check',
		type = 'button',
		onclick
	}: {
		/** Nothing to commit yet, or the answer is already in. */
		disabled?: boolean;
		label?: string;
		/**
		 * `submit` where the challenge is wrapped in a form, so Enter in a field
		 * commits it; the form's own handler does the work and no `onclick` is
		 * needed.
		 */
		type?: 'button' | 'submit';
		onclick?: () => void;
	} = $props();
</script>

{#if type === 'submit'}
	<button type="submit" class="btn btn-primary btn-block check" {disabled}>{label}</button>
{:else}
	<button type="button" class="btn btn-primary btn-block check" {disabled} {onclick}>
		{label}
	</button>
{/if}
