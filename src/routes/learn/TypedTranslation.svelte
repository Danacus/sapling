<!--
  Typed translation: the hardest of the four types, because nothing is given
  away — the learner produces the whole string.

  Graded by `validateAnswer` against every accepted form the generator listed,
  so a missing accent or a single typo lands on 'almost' instead of 'wrong'.
  Enter submits.
-->
<script lang="ts">
	import { ALL_READINGS, rubyFor, storedReading, type ChallengeProps } from '$lib/challenges/props';
	import type { TypedTranslationChallenge } from '$lib/types';
	import { validateAnswer } from '$lib/validate';
	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import CheckButton from './blocks/CheckButton.svelte';
	import PromptHeader from './blocks/PromptHeader.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		nativeLanguage = '',
		readings = ALL_READINGS,
		tokenize = null
	}: ChallengeProps<TypedTranslationChallenge> = $props();

	let typed = $state('');
	let input = $state<HTMLTextAreaElement | null>(null);

	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			typed = '';
		}
	);

	// Kept separate from the reset above: this one depends on the `bind:this`
	// landing, and re-running the reset when it does would clear the field.
	$effect(() => {
		void challenge.id;
		input?.focus();
	});

	const into = $derived(challenge.direction === 'toTarget' ? targetLanguage : nativeLanguage);
	const asked = $derived(into ? `Write this in ${into}` : 'Write the translation');
	/**
	 * Only worth hearing when the prompt itself is the target language. Going
	 * the other way, the answer is what's worth hearing — the feedback banner
	 * speaks it once the learner has committed.
	 */
	const promptIsTarget = $derived(challenge.direction === 'toNative');
	/**
	 * The prompt is the only target-language text on screen — the answer is
	 * still in the learner's head — and only in one direction, which is the same
	 * condition the stored `promptRomanization` is written under. `null` falls
	 * the whole line back to that stored string.
	 */
	const promptTokens = $derived(
		promptIsTarget ? rubyFor(tokenize, readings)(challenge.prompt) : null
	);
	const ready = $derived(typed.trim().length > 0 && !lock.locked);

	function submit(): void {
		if (!ready) return;
		const answerGiven = typed.trim();
		const { verdict, closestAccepted } = validateAnswer(answerGiven, challenge.acceptedAnswers);
		onanswer({
			answerGiven,
			verdict,
			responseMs: lock.commit(),
			closestAccepted
		});
	}

	function onkeydown(event: KeyboardEvent): void {
		// A translation is one line; Enter is "check", not "newline".
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	}
</script>

<div class="typed">
	<PromptHeader
		kicker={asked}
		prompt={challenge.prompt}
		{promptTokens}
		reading={storedReading(readings, challenge.promptRomanization)}
		speakText={promptIsTarget ? challenge.prompt : ''}
		speakLang={targetLanguage}
	/>

	<textarea
		bind:this={input}
		bind:value={typed}
		class="input answer"
		rows="2"
		autocomplete="off"
		autocapitalize="sentences"
		spellcheck="false"
		disabled={lock.locked}
		placeholder="Type your answer"
		aria-label="Your translation"
		{onkeydown}
	></textarea>

	<CheckButton disabled={!ready} onclick={submit} />
</div>

<style>
	.typed {
		display: flex;
		flex-direction: column;
	}

	/* The writing surface. Everything else on this screen is printed; this is
	   the one place the learner puts ink on the page, so it keeps the body face
	   at a comfortable hand size and takes a terracotta caret. */
	.answer {
		margin-bottom: 1.5rem;
		font-size: 1.15rem;
		font-weight: 500;
		line-height: 1.5;
		caret-color: var(--accent);
		resize: none;
	}

	.answer::placeholder {
		font-weight: 400;
		font-style: italic;
	}
</style>
