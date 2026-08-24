<!--
  Spot the error: one word in the sentence does not belong.

  The sentence is laid out as tappable word tiles and the native-language
  meaning sits under it — that meaning is not decoration, it is the whole
  premise: without knowing what the sentence is *supposed* to say, a wrong word
  is indistinguishable from a word you have not met yet.

  Grading is a plain index comparison, like multiple choice: the learner picked
  a token rather than producing a string, so there is no fuzzy matching and this
  type can never return 'almost'. Selecting does not submit.

  Deliberately silent before answering. The sentence on screen is wrong on
  purpose, and reading it aloud would teach the mistake; the feedback banner
  speaks the *corrected* sentence instead (`spokenAnswerFor`).

  Keyboard: 1-9 select the first nine words, Enter checks.
-->
<script lang="ts">
	import { choiceKeyAction } from '$lib/challenges/keyboard';
	import type { ChallengeProps } from '$lib/challenges/props';
	import type { SpotErrorChallenge } from '$lib/types';
	import { getShowRomanization } from '$lib/ui/prefs';
	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import CheckButton from './blocks/CheckButton.svelte';
	import PromptHeader from './blocks/PromptHeader.svelte';
	import TapOption from './blocks/TapOption.svelte';
	import TapRow from './blocks/TapRow.svelte';

	// Both languages are offered to every challenge component; this one needs
	// neither — it is deliberately silent, and the meaning line is already
	// native-language text carried on the challenge.
	let { challenge, onanswer }: ChallengeProps<SpotErrorChallenge> = $props();

	/** Read once — the toggle lives in Settings, not mid-session. */
	const showRomanization = getShowRomanization();

	let selected = $state<number | null>(null);

	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			selected = null;
		}
	);

	function readingOf(index: number): string {
		return (showRomanization ? challenge.tokensRomanization?.[index] : '') ?? '';
	}

	function select(index: number): void {
		if (lock.locked) return;
		selected = selected === index ? null : index;
	}

	function submit(): void {
		if (lock.locked || selected === null) return;
		onanswer({
			// The token they tapped, so the result log and any escalation see the
			// same string the learner saw.
			answerGiven: challenge.tokens[selected],
			verdict: selected === challenge.correctIndex ? 'correct' : 'wrong',
			responseMs: lock.commit()
		});
	}

	/**
	 * Digits 1-9 pick, Enter checks; the rule itself is in `$lib/challenges`.
	 * The ceiling is 9 rather than the token count because there is no `10` key —
	 * a longer sentence simply has tiles the keyboard cannot reach.
	 */
	function onkeydown(event: KeyboardEvent): void {
		const action = choiceKeyAction(event, {
			count: Math.min(9, challenge.tokens.length),
			locked: lock.locked,
			hasSelection: selected !== null
		});
		if (action.kind === 'ignore') return;
		event.preventDefault();
		if (action.kind === 'select') select(action.index);
		else submit();
	}
</script>

<svelte:window {onkeydown} />

<div class="spot">
	<PromptHeader kicker="Tap the word that's wrong" />

	<div class="sentence">
		<TapRow align="end" role="radiogroup" label="Words in the sentence">
			{#each challenge.tokens as token, index (index)}
				<TapOption
					text={token}
					reading={readingOf(index)}
					size="inline"
					selection="radio"
					state={selected === index ? 'selected' : 'idle'}
					disabled={lock.locked}
					onclick={() => select(index)}
				/>
			{/each}
		</TapRow>
	</div>

	<p class="meaning">It should mean: {challenge.meaning}</p>

	<CheckButton disabled={selected === null || lock.locked} onclick={submit} />
</div>

<style>
	.spot {
		display: flex;
		flex-direction: column;
	}

	.sentence {
		margin-bottom: 1rem;
	}

	.meaning {
		margin: 0 0 1.5rem;
		font-size: 1rem;
		font-style: italic;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}
</style>
