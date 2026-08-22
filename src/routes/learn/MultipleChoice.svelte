<!--
  Multiple choice: four big tap targets, one right.

  Grading is a plain index comparison — no fuzzy matching, because the learner
  did not produce the string, they picked it. That also means this type can
  never return 'almost'.

  Keyboard: 1-4 select, Enter checks. Selecting does not submit; a wrong tap
  should always be recoverable before committing.
-->
<script lang="ts">
	import type { AnswerEvent } from '$lib/session/engine';
	import type { MultipleChoiceChallenge } from '$lib/types';

	let {
		challenge,
		onanswer
	}: { challenge: MultipleChoiceChallenge; onanswer: (event: AnswerEvent) => void } = $props();

	/** Reset per challenge: `challenge.id` is the tracked read. */
	let selected = $state<number | null>(null);
	let locked = $state(false);
	let shownAt = $state(Date.now());

	$effect(() => {
		void challenge.id;
		selected = null;
		locked = false;
		shownAt = Date.now();
	});

	const askedIn = $derived(challenge.direction === 'toTarget' ? 'Pick the translation' : 'What does this mean?');

	function select(index: number): void {
		if (locked) return;
		selected = index;
	}

	function submit(): void {
		if (locked || selected === null) return;
		locked = true;
		onanswer({
			answerGiven: challenge.options[selected],
			verdict: selected === challenge.correctIndex ? 'correct' : 'wrong',
			responseMs: Date.now() - shownAt
		});
	}

	function onkeydown(event: KeyboardEvent): void {
		if (locked || event.metaKey || event.ctrlKey || event.altKey) return;

		const digit = Number.parseInt(event.key, 10);
		if (digit >= 1 && digit <= challenge.options.length) {
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

<div class="mc">
	<p class="asked">{askedIn}</p>
	<p class="prompt">{challenge.prompt}</p>

	<div class="options" role="radiogroup" aria-label="Answer options">
		{#each challenge.options as option, index (index)}
			<button
				type="button"
				class="option"
				class:chosen={selected === index}
				role="radio"
				aria-checked={selected === index}
				disabled={locked}
				onclick={() => select(index)}
			>
				<span class="key" aria-hidden="true">{index + 1}</span>
				<span class="label">{option}</span>
			</button>
		{/each}
	</div>

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
	.mc {
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
		margin: 0 0 1.5rem;
		font-size: 1.9rem;
		font-weight: 800;
		line-height: 1.15;
		letter-spacing: -0.015em;
		overflow-wrap: anywhere;
	}

	.options {
		display: grid;
		gap: 0.7rem;
		margin-bottom: 1.5rem;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 0.85rem;
		width: 100%;
		padding: 1rem 1.1rem;
		border: 2px solid var(--border);
		border-bottom-width: 4px;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-weight: 700;
		font-size: 1.05rem;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.12s ease,
			background 0.12s ease,
			transform 0.08s ease;
	}

	.option:hover:not(:disabled) {
		background: var(--surface-alt);
	}

	.option:active:not(:disabled) {
		transform: translateY(2px);
		border-bottom-width: 2px;
	}

	.option:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.option.chosen {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.option:disabled {
		cursor: default;
		opacity: 0.75;
	}

	.key {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 1.75rem;
		height: 1.75rem;
		border: 2px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.8rem;
		font-weight: 800;
		color: var(--text-muted);
	}

	.option.chosen .key {
		border-color: var(--accent);
		color: var(--accent);
	}

	.label {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.check {
		margin-top: auto;
	}

	/* The number badges are a keyboard affordance; useless on touch. */
	@media (pointer: coarse) {
		.key {
			display: none;
		}
	}

	@media (max-width: 480px) {
		.prompt {
			font-size: 1.5rem;
		}

		.option {
			padding: 0.85rem 0.9rem;
			font-size: 1rem;
		}
	}
</style>
