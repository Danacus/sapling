<!--
  The muted stored-romanization line under a target line: one flat LLM-written
  string for a whole sentence, the fallback wherever there is no local
  romanizer. `PromptHeader`, `Cloze` and `MultiCloze` each rendered their own
  `<p class="rom …">`; the block owns the line now.

  Two spacings, not three. The prompt line and the passage line had the same
  `1.3rem` bottom margin under two names, so they are one variant; only the
  cloze sentence line wants the tighter `0.6rem`. `variant` names the spacing,
  which is the only thing that actually differs.

  Deliberately dumb: the caller has already applied the reading preference, so
  this only prints the string it is handed. `.rom` itself is the shared app.css
  rule; the variants only set spacing.
-->
<script lang="ts">
	let {
		reading,
		variant = 'loose'
	}: {
		/** The stored reading string, already gated by the caller. */
		reading: string;
		/** The two spacings the layout actually uses. */
		variant?: 'loose' | 'tight';
	} = $props();
</script>

<p class="rom {variant}-rom">{reading}</p>

<style>
	.loose-rom {
		margin: 0 0 1.3rem;
		font-size: 1rem;
	}

	.tight-rom {
		margin: 0 0 0.6rem;
		font-size: 1rem;
	}
</style>
