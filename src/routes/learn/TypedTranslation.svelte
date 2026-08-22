<!--
  Typed translation: the hardest of the four types, because nothing is given
  away — the learner produces the whole string.

  Graded by `validateAnswer` against every accepted form the generator listed,
  so a missing accent or a single typo lands on 'almost' instead of 'wrong'.
  Enter submits.
-->
<script lang="ts">
	import type { AnswerEvent } from '$lib/session/engine';
	import type { TypedTranslationChallenge } from '$lib/types';
	import { getShowRomanization } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import { validateAnswer } from '$lib/validate';

	/** Read once — the toggle lives in Settings, not mid-session. */
	const showRomanization = getShowRomanization();

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		nativeLanguage = ''
	}: {
		challenge: TypedTranslationChallenge;
		onanswer: (event: AnswerEvent) => void;
		targetLanguage?: string;
		nativeLanguage?: string;
	} = $props();

	let typed = $state('');
	let locked = $state(false);
	let shownAt = $state(Date.now());
	let input = $state<HTMLTextAreaElement | null>(null);

	$effect(() => {
		void challenge.id;
		typed = '';
		locked = false;
		shownAt = Date.now();
	});

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
	const ready = $derived(typed.trim().length > 0 && !locked);

	function submit(): void {
		if (!ready) return;
		locked = true;
		const answerGiven = typed.trim();
		const { verdict, closestAccepted } = validateAnswer(answerGiven, challenge.acceptedAnswers);
		onanswer({
			answerGiven,
			verdict,
			responseMs: Date.now() - shownAt,
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
	<p class="asked">{asked}</p>
	<p class="prompt">
		<span>{challenge.prompt}</span>
		{#if promptIsTarget}
			<SpeakButton text={challenge.prompt} lang={targetLanguage} />
		{/if}
	</p>
	{#if showRomanization && challenge.promptRomanization}
		<p class="rom prompt-rom">{challenge.promptRomanization}</p>
	{/if}

	<textarea
		bind:this={input}
		bind:value={typed}
		class="input answer"
		rows="2"
		autocomplete="off"
		autocapitalize="sentences"
		spellcheck="false"
		disabled={locked}
		placeholder="Type your answer"
		aria-label="Your translation"
		{onkeydown}
	></textarea>

	<button type="button" class="btn btn-primary btn-block check" disabled={!ready} onclick={submit}>
		Check
	</button>
</div>

<style>
	.typed {
		display: flex;
		flex-direction: column;
	}

	.asked {
		margin: 0 0 0.4rem;
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.prompt {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 1.5rem;
		font-size: 1.9rem;
		font-weight: 800;
		line-height: 1.2;
		letter-spacing: -0.015em;
		overflow-wrap: anywhere;
	}

	.prompt > span {
		min-width: 0;
	}

	/* When romanization follows the prompt, it owns the trailing space instead. */
	.prompt:has(+ .prompt-rom) {
		margin-bottom: 0.2rem;
	}

	.prompt-rom {
		margin-bottom: 1.3rem;
		font-size: 1rem;
	}

	.answer {
		margin-bottom: 1.5rem;
		font-size: 1.15rem;
		font-weight: 700;
		line-height: 1.4;
		resize: none;
	}

	.check {
		margin-top: auto;
	}

	@media (max-width: 480px) {
		.prompt {
			font-size: 1.5rem;
		}
	}
</style>
