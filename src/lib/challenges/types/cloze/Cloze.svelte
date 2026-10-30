<!-- Cloze: one blank in a model-written sentence, its native line as the hint. -->
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
	}: ChallengeProps<'cloze'> = $props();
</script>

<ClozeForm
	challenge={{ ...challenge, hint: challenge.translationHint }}
	{screen}
	{graded}
	{onanswer}
	{targetLanguageTag}
	{tokenize}
/>
