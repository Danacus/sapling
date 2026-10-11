<!-- Type → component dispatch through the compile-time plugin registry. -->
<script lang="ts">
	import { componentFor } from '$lib/challenges/types';
	import type { RomanizedToken } from '$lib/romanize';
	import type { Challenge, ChallengeAnswer, Graded, Served } from '$lib/types';

	let {
		challenge,
		served,
		graded,
		onanswer,
		targetLanguage = '',
		nativeLanguage = '',
		tokenize = null
	}: {
		challenge: Challenge;
		served: Served;
		graded?: Graded;
		onanswer: (answer: ChallengeAnswer, responseMs: number) => void;
		targetLanguage?: string;
		nativeLanguage?: string;
		tokenize?: ((text: string) => RomanizedToken[]) | null;
	} = $props();

	const Component = $derived(componentFor(challenge.type));
	const screen = $derived(served.screen.screen);
	function answer(answer: unknown, responseMs: number): void {
		onanswer({ type: challenge.type, answer } as ChallengeAnswer, responseMs);
	}
</script>

<Component
	{challenge}
	{screen}
	{graded}
	onanswer={answer}
	{targetLanguage}
	{nativeLanguage}
	{tokenize}
/>
