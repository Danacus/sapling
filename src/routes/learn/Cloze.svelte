<!--
  Cloze: one blank in a sentence.

  Two input modes, chosen by the challenge itself:
  - `wordBank` present → tappable chips. Tapping fills the blank, tapping the
    same chip again clears it. This is the beginner-friendly mode; the answer
    space is bounded, so the learner is reading and choosing rather than
    spelling.
  - no `wordBank` → an inline text input sitting *inside* the sentence, so the
    gap keeps its place in the reading order instead of turning into a
    disconnected field below.

  Both modes grade through `validateAnswer`, which is what makes an accent slip
  an 'almost' rather than a 'wrong'.
-->
<script lang="ts">
	import type { AnswerEvent } from '$lib/session/engine';
	import type { ClozeChallenge } from '$lib/types';
	import { getShowRomanization } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import { validateAnswer } from '$lib/validate';

	let {
		challenge,
		onanswer,
		targetLanguage = ''
	}: {
		challenge: ClozeChallenge;
		onanswer: (event: AnswerEvent) => void;
		targetLanguage?: string;
	} = $props();

	/** Read once — the toggle lives in Settings, not mid-session. */
	const showRomanization = getShowRomanization();

	const GAP = '___';

	/** The sentence either side of the (first) blank. */
	const parts = $derived.by(() => {
		const index = challenge.sentence.indexOf(GAP);
		if (index < 0) return { before: challenge.sentence, after: '' };
		return {
			before: challenge.sentence.slice(0, index),
			after: challenge.sentence.slice(index + GAP.length)
		};
	});

	const bank = $derived(challenge.wordBank ?? []);
	const usesBank = $derived(bank.length > 0);

	let typed = $state('');
	let pickedIndex = $state<number | null>(null);
	let locked = $state(false);
	let shownAt = $state(Date.now());
	let input = $state<HTMLInputElement | null>(null);

	$effect(() => {
		void challenge.id;
		typed = '';
		pickedIndex = null;
		locked = false;
		shownAt = Date.now();
	});

	$effect(() => {
		void challenge.id;
		if (!usesBank) input?.focus();
	});

	const answer = $derived(
		usesBank ? (pickedIndex === null ? '' : bank[pickedIndex]) : typed.trim()
	);
	const ready = $derived(answer.length > 0 && !locked);

	/**
	 * What the speaker button says.
	 *
	 * Before answering it must not give the answer away, so the `___` becomes
	 * an ellipsis — every TTS engine reads that as a short pause, which is
	 * exactly the "…and then?" the learner needs. Once the challenge is locked
	 * the sentence is spoken complete, using the first accepted answer as the
	 * canonical form.
	 */
	const spokenSentence = $derived(
		challenge.sentence.split(GAP).join(locked ? (challenge.acceptedAnswers[0] ?? '…') : '…')
	);

	function pick(index: number): void {
		if (locked) return;
		// Tapping the chip that is already in the gap takes it back out.
		pickedIndex = pickedIndex === index ? null : index;
	}

	function submit(): void {
		if (!ready) return;
		locked = true;
		const { verdict, closestAccepted } = validateAnswer(answer, challenge.acceptedAnswers);
		onanswer({
			answerGiven: answer,
			verdict,
			responseMs: Date.now() - shownAt,
			closestAccepted
		});
	}

	function onFormSubmit(event: SubmitEvent): void {
		event.preventDefault();
		submit();
	}
</script>

<form class="cloze" onsubmit={onFormSubmit}>
	<p class="asked">Fill in the blank</p>

	<p class="sentence">
		<span>{parts.before}</span>
		{#if usesBank}
			<button
				type="button"
				class="gap"
				class:filled={pickedIndex !== null}
				disabled={locked}
				aria-label={pickedIndex === null ? 'Empty blank' : `Blank filled with ${answer}`}
				onclick={() => (pickedIndex = null)}
			>
				{pickedIndex === null ? GAP : answer}
			</button>
		{:else}
			<input
				bind:this={input}
				bind:value={typed}
				class="gap gap-input"
				type="text"
				size={Math.max(6, answer.length + 1)}
				autocomplete="off"
				autocapitalize="off"
				autocorrect="off"
				spellcheck="false"
				disabled={locked}
				aria-label="Your answer for the blank"
				placeholder="…"
			/>
		{/if}
		<span>{parts.after}</span>
		<SpeakButton text={spokenSentence} lang={targetLanguage} />
	</p>
	{#if showRomanization && challenge.sentenceRomanization}
		<p class="rom sentence-rom">{challenge.sentenceRomanization}</p>
	{/if}

	<p class="hint translation">{challenge.translationHint}</p>

	{#if usesBank}
		<div class="bank">
			{#each bank as word, index (index)}
				<button
					type="button"
					class="chip"
					class:used={pickedIndex === index}
					disabled={locked}
					onclick={() => pick(index)}
				>
					{word}
				</button>
			{/each}
		</div>
	{/if}

	<button type="submit" class="btn btn-primary btn-block check" disabled={!ready}>Check</button>
</form>

<style>
	.cloze {
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

	.sentence {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0;
		margin: 0 0 0.6rem;
		font-size: 1.55rem;
		font-weight: 800;
		line-height: 1.5;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	/* The sentence line is baseline-aligned for the inline gap; the speaker
	   button is an icon, so it centres on the line instead. */
	.sentence :global(.speak) {
		align-self: center;
	}

	.gap {
		display: inline-block;
		min-width: 5.5rem;
		margin: 0 0.15rem;
		padding: 0.1rem 0.55rem;
		border: 0;
		border-bottom: 3px dashed var(--border-strong);
		border-radius: var(--radius-sm) var(--radius-sm) 0 0;
		background: var(--surface-alt);
		color: var(--text-muted);
		font: inherit;
		text-align: center;
		cursor: pointer;
	}

	.gap.filled {
		border-bottom-style: solid;
		border-bottom-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
	}

	.gap:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.gap-input {
		cursor: text;
		color: var(--text);
		max-width: 100%;
	}

	.gap-input:focus {
		outline: none;
		border-bottom-color: var(--accent);
		background: var(--accent-soft);
	}

	.gap:disabled {
		cursor: default;
		opacity: 0.8;
	}

	.sentence-rom {
		margin: 0 0 0.6rem;
		font-size: 1rem;
	}

	.translation {
		margin: 0 0 1.4rem;
		font-size: 1rem;
		font-style: italic;
	}

	.bank {
		display: flex;
		flex-wrap: wrap;
		gap: 0.55rem;
		margin-bottom: 1.5rem;
	}

	.chip {
		padding: 0.6rem 1rem;
		border: 2px solid var(--border);
		border-bottom-width: 4px;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
		transition:
			transform 0.08s ease,
			opacity 0.15s ease,
			background 0.15s ease;
	}

	.chip:hover:not(:disabled) {
		background: var(--surface-alt);
	}

	.chip:active:not(:disabled) {
		transform: translateY(2px);
		border-bottom-width: 2px;
	}

	.chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* The chip currently sitting in the gap stays visible but clearly spent. */
	.chip.used {
		opacity: 0.35;
		border-style: dashed;
		border-bottom-width: 2px;
	}

	.chip:disabled {
		cursor: default;
	}

	.check {
		margin-top: auto;
	}

	@media (max-width: 480px) {
		.sentence {
			font-size: 1.25rem;
		}
	}
</style>
