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
	import type { AnswerEvent } from '$lib/session/engine';
	import type { SpotErrorChallenge } from '$lib/types';
	import { getShowRomanization } from '$lib/ui/prefs';

	let {
		challenge,
		onanswer
	}: {
		challenge: SpotErrorChallenge;
		onanswer: (event: AnswerEvent) => void;
	} = $props();

	/** Read once — the toggle lives in Settings, not mid-session. */
	const showRomanization = getShowRomanization();

	let selected = $state<number | null>(null);
	let locked = $state(false);
	let shownAt = $state(Date.now());

	$effect(() => {
		void challenge.id;
		selected = null;
		locked = false;
		shownAt = Date.now();
	});

	function romanizationOf(index: number): string | undefined {
		return showRomanization ? challenge.tokensRomanization?.[index] : undefined;
	}

	function select(index: number): void {
		if (locked) return;
		selected = selected === index ? null : index;
	}

	function submit(): void {
		if (locked || selected === null) return;
		locked = true;
		onanswer({
			// The token they tapped, so the result log and any escalation see the
			// same string the learner saw.
			answerGiven: challenge.tokens[selected],
			verdict: selected === challenge.correctIndex ? 'correct' : 'wrong',
			responseMs: Date.now() - shownAt
		});
	}

	function onkeydown(event: KeyboardEvent): void {
		if (locked || event.metaKey || event.ctrlKey || event.altKey) return;

		const digit = Number.parseInt(event.key, 10);
		if (digit >= 1 && digit <= Math.min(9, challenge.tokens.length)) {
			event.preventDefault();
			select(digit - 1);
			return;
		}

		if (event.key === 'Enter' && selected !== null) {
			event.preventDefault();
			submit();
		}
	}
</script>

<svelte:window {onkeydown} />

<div class="spot">
	<p class="asked">Tap the word that's wrong</p>

	<div class="sentence" role="radiogroup" aria-label="Words in the sentence">
		{#each challenge.tokens as token, index (index)}
			<button
				type="button"
				class="token"
				class:chosen={selected === index}
				role="radio"
				aria-checked={selected === index}
				disabled={locked}
				onclick={() => select(index)}
			>
				<span>{token}</span>
				{#if romanizationOf(index)}
					<span class="rom">{romanizationOf(index)}</span>
				{/if}
			</button>
		{/each}
	</div>

	<p class="meaning">It should mean: {challenge.meaning}</p>

	<button
		type="button"
		class="btn btn-primary btn-block check"
		disabled={selected === null || locked}
		onclick={submit}
	>
		Check
	</button>
</div>

<style>
	.spot {
		display: flex;
		flex-direction: column;
	}

	.asked {
		margin: 0 0 0.6rem;
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.sentence {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.4rem;
		margin-bottom: 1rem;
	}

	.token {
		padding: 0.45rem 0.7rem;
		border: 2px solid transparent;
		border-bottom: 3px dashed var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
		color: var(--text);
		font: inherit;
		font-size: 1.35rem;
		font-weight: 800;
		line-height: 1.2;
		cursor: pointer;
		overflow-wrap: anywhere;
		transition:
			border-color 0.12s ease,
			background 0.12s ease,
			transform 0.08s ease;
	}

	.token:hover:not(:disabled) {
		background: var(--surface);
	}

	.token:active:not(:disabled) {
		transform: translateY(1px);
	}

	.token:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.token.chosen {
		border-color: var(--accent);
		border-bottom-style: solid;
		background: var(--accent-soft);
	}

	.token:disabled {
		cursor: default;
		opacity: 0.8;
	}

	/* The reading sits under its own word, so a long sentence still lines up. */
	.token :global(.rom) {
		display: block;
		font-size: 0.72rem;
		font-weight: 600;
	}

	.meaning {
		margin: 0 0 1.5rem;
		font-size: 1rem;
		font-style: italic;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.check {
		margin-top: auto;
	}

	@media (max-width: 480px) {
		.token {
			font-size: 1.1rem;
			padding: 0.4rem 0.55rem;
		}
	}
</style>
