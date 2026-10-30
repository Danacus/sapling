<!--
  Cue-cloze: one of the learner's own subtitle cues with their word blanked.
  A cue has no translation, so the hint is the word's meaning; readings are
  romanized at render time, as for any row without stored ones.
-->
<script lang="ts">
	import type { ChallengeProps } from '$lib/challenges/props';
	import ClozeForm from '$lib/challenges/blocks/ClozeForm.svelte';

	let {
		challenge,
		screen,
		graded,
		onanswer,
		targetLanguageTag,
		tokenize = null
	}: ChallengeProps<'cue-cloze'> = $props();
</script>

<ClozeForm
	challenge={{ ...challenge, hint: challenge.meaningHint }}
	{screen}
	{graded}
	{onanswer}
	{targetLanguageTag}
	{tokenize}
/>
