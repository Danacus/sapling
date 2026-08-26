<!--
  Type → component dispatch, and nothing else.

  The session screen used to carry this chain inline, with the final `{:else}`
  standing in for match-pairs by implication — so the compiler had no idea the
  chain was meant to be total, and a seventh challenge type would have rendered
  as a matching round rather than failing anything.

  Still an `{#if}` chain rather than a `{ type: Component }` map, deliberately:
  the chain is what narrows `challenge` to the concrete member each component
  declares. A lookup table erases that and hands every component a bare
  `Challenge`, which then has to be cast back — trading a checked dispatch for
  an unchecked one to save six lines.

  What makes it total is the last branch: with all six tags claimed, `challenge`
  is `never` there, and {@link unhandledChallenge} only accepts `never`. Add a
  member to the union and `pnpm check` fails right here.

  Every component gets both language names whether it uses them or not — see
  `ChallengeProps`. Nothing is rendered around the components: the session
  screen's `.challenge` flex column is their direct parent, and it stays that
  way.
-->
<script lang="ts">
	import { unhandledChallenge } from '$lib/challenges/display';
	import { ALL_READINGS } from '$lib/challenges/props';
	import type { RomanizedToken } from '$lib/romanize';
	import type { AnswerEvent } from '$lib/session/engine';
	import type { ReadingPlan } from '$lib/session/romanization';
	import type { Challenge } from '$lib/types';

	import Cloze from './Cloze.svelte';
	import MatchPairs from './MatchPairs.svelte';
	import MultipleChoice from './MultipleChoice.svelte';
	import SpotError from './SpotError.svelte';
	import TypedTranslation from './TypedTranslation.svelte';
	import WordOrder from './WordOrder.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		nativeLanguage = '',
		readings = ALL_READINGS,
		tokenize = null
	}: {
		challenge: Challenge;
		onanswer: (event: AnswerEvent) => void;
		targetLanguage?: string;
		nativeLanguage?: string;
		readings?: ReadingPlan;
		tokenize?: ((text: string) => RomanizedToken[]) | null;
	} = $props();
</script>

{#if challenge.type === 'multiple-choice'}
	<MultipleChoice {challenge} {onanswer} {targetLanguage} {nativeLanguage} {readings} {tokenize} />
{:else if challenge.type === 'cloze'}
	<Cloze {challenge} {onanswer} {targetLanguage} {nativeLanguage} {readings} {tokenize} />
{:else if challenge.type === 'typed-translation'}
	<TypedTranslation
		{challenge}
		{onanswer}
		{targetLanguage}
		{nativeLanguage}
		{readings}
		{tokenize}
	/>
{:else if challenge.type === 'word-order'}
	<WordOrder {challenge} {onanswer} {targetLanguage} {nativeLanguage} {readings} {tokenize} />
{:else if challenge.type === 'spot-error'}
	<SpotError {challenge} {onanswer} {targetLanguage} {nativeLanguage} {readings} {tokenize} />
{:else if challenge.type === 'match-pairs'}
	<MatchPairs {challenge} {onanswer} {targetLanguage} {nativeLanguage} {readings} {tokenize} />
{:else}
	{unhandledChallenge(challenge)}
{/if}
