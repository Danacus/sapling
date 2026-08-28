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

  The sentence line is the one prompt no block renders: it is not text with a
  speaker next to it, it is an interactive line with a control *in* it, and the
  gap has to sit in the reading order where the word belongs. So the kicker
  comes from `PromptHeader` and the line below it stays this component's own.
-->
<script lang="ts">
	import { ALL_READINGS, rubyFor, storedReading, type ChallengeProps } from '$lib/challenges/props';
	import type { RomanizedToken } from '$lib/romanize';
	import type { ClozeChallenge } from '$lib/types';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import { validateAnswer } from '$lib/validate';
	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import CheckButton from './blocks/CheckButton.svelte';
	import PromptHeader from './blocks/PromptHeader.svelte';
	import RubyText from './blocks/RubyText.svelte';
	import TapOption from './blocks/TapOption.svelte';
	import WordBank from './blocks/WordBank.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		readings = ALL_READINGS,
		tokenize = null
	}: ChallengeProps<ClozeChallenge> = $props();

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

	const ruby = $derived(rubyFor(tokenize, readings));

	/**
	 * The same two halves, as ruby tokens — or `null` where this language has no
	 * local romanizer and the stored `sentenceRomanization` line below takes over.
	 *
	 * Romanized from the **whole** sentence, gap and all, and split afterwards:
	 * readings are context-dependent, so tokenizing the two halves separately
	 * would ask the romanizer to read each of them as its own sentence. The gap
	 * comes back inside an unreadable (`reading: null`) token, possibly with the
	 * spaces or punctuation around it merged in — hence the slicing, which keeps
	 * every character of the original on the correct side of the blank.
	 */
	const rubyParts = $derived.by(() => {
		const tokens = ruby(challenge.sentence);
		if (!tokens) return null;

		const before: RomanizedToken[] = [];
		const after: RomanizedToken[] = [];
		let split = false;
		for (const token of tokens) {
			if (split) {
				after.push(token);
				continue;
			}
			const at = token.text.indexOf(GAP);
			if (at < 0) {
				before.push(token);
				continue;
			}
			if (at > 0) before.push({ text: token.text.slice(0, at), reading: null });
			const tail = token.text.slice(at + GAP.length);
			if (tail) after.push({ text: tail, reading: null });
			split = true;
		}
		return { before, after };
	});

	const bank = $derived(challenge.wordBank ?? []);
	const usesBank = $derived(bank.length > 0);

	let typed = $state('');
	let pickedIndex = $state<number | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			typed = '';
			pickedIndex = null;
		}
	);

	// Kept separate from the reset above: this one depends on the `bind:this`
	// landing, and re-running the reset when it does would clear the field.
	$effect(() => {
		void challenge.id;
		if (!usesBank) input?.focus();
	});

	const answer = $derived(
		usesBank ? (pickedIndex === null ? '' : bank[pickedIndex]) : typed.trim()
	);
	const ready = $derived(answer.length > 0 && !lock.locked);

	/** The sentence with the blank filled in by the canonical accepted answer. */
	const completedSentence = $derived(
		challenge.sentence.split(GAP).join(challenge.acceptedAnswers[0] ?? '…')
	);

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
		lock.locked ? completedSentence : challenge.sentence.split(GAP).join('…')
	);

	function tokensOf(index: number): RomanizedToken[] | null {
		return ruby(bank[index]);
	}

	/**
	 * The picked word, as the same ruby tokens its bank chip wore — a word must
	 * not lose its reading by being placed in the gap. `null` (no pick, or no
	 * local romanizer) falls back to the plain text.
	 */
	const gapTokens = $derived(pickedIndex === null ? null : ruby(bank[pickedIndex]));

	function readingOf(index: number): string {
		return storedReading(readings, challenge.wordBankRomanization?.[index]);
	}

	function pick(index: number): void {
		if (lock.locked) return;
		// Tapping the chip that is already in the gap takes it back out.
		pickedIndex = pickedIndex === index ? null : index;
	}

	function submit(): void {
		if (!ready) return;
		const { verdict, closestAccepted } = validateAnswer(answer, challenge.acceptedAnswers);
		// No speech here: the feedback banner auto-plays the completed sentence
		// for every challenge type in one place, so cloze stays consistent with
		// the rest instead of being the one type that speaks for itself.
		onanswer({
			answerGiven: answer,
			verdict,
			responseMs: lock.commit(),
			closestAccepted
		});
	}

	function onFormSubmit(event: SubmitEvent): void {
		event.preventDefault();
		submit();
	}
</script>

<form class="cloze" onsubmit={onFormSubmit}>
	<PromptHeader kicker="Fill in the blank" />

	<p class="sentence">
		{#if rubyParts}<RubyText tokens={rubyParts.before} />{:else}<span>{parts.before}</span>{/if}
		{#if usesBank}
			<button
				type="button"
				class="gap"
				class:filled={pickedIndex !== null}
				disabled={lock.locked}
				aria-label={pickedIndex === null ? 'Empty blank' : `Blank filled with ${answer}`}
				onclick={() => (pickedIndex = null)}
			>
				{#if pickedIndex === null}{GAP}{:else if gapTokens}<RubyText
						tokens={gapTokens}
					/>{:else}{answer}{/if}
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
				disabled={lock.locked}
				aria-label="Your answer for the blank"
				placeholder="…"
			/>
		{/if}
		{#if rubyParts}<RubyText tokens={rubyParts.after} />{:else}<span>{parts.after}</span>{/if}
		<SpeakButton text={spokenSentence} lang={targetLanguage} />
	</p>
	<!-- The stored one-line romanization, only where ruby is not already
	     carrying the readings word by word. -->
	{#if !rubyParts && readings.sentence && challenge.sentenceRomanization}
		<p class="rom sentence-rom">{challenge.sentenceRomanization}</p>
	{/if}

	<p class="hint translation">{challenge.translationHint}</p>

	{#if usesBank}
		<WordBank>
			{#each bank as word, index (index)}
				<TapOption
					text={word}
					reading={readingOf(index)}
					tokens={tokensOf(index)}
					state={pickedIndex === index ? 'spent' : 'idle'}
					disabled={lock.locked}
					onclick={() => pick(index)}
				/>
			{/each}
		</WordBank>
	{/if}

	<CheckButton type="submit" disabled={!ready} />
</form>

<style>
	.cloze {
		display: flex;
		flex-direction: column;
	}

	/* The sentence is this type's prompt, so it takes the same display face
	   `PromptHeader` gives every other type's — with the stack still falling
	   through to the system fonts for non-Latin scripts. */
	.sentence {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0;
		margin: 0 0 0.6rem;
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
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

	/*
	  The blank itself — the one idiom no other type has. Deliberately not a
	  `.tap`: it is a hole in a sentence, drawn as a dashed rule the word lands
	  on, and both modes (the tappable button and the inline input) wear it so
	  the gap looks the same whether the learner picks or spells.
	*/
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
		caret-color: var(--accent);
		max-width: 100%;
	}

	.gap-input:focus {
		outline: none;
		border-bottom-color: var(--accent);
		background: var(--accent-soft);
	}

	.gap:disabled {
		cursor: default;
		opacity: 0.75;
	}

	.sentence-rom {
		margin: 0 0 0.6rem;
		font-size: 1rem;
	}

	/* The meaning, pencilled in the margin: a hairline rule to the left of it
	   marks it as a gloss on the sentence rather than a second instruction. */
	.translation {
		margin: 0 0 1.4rem;
		padding-left: 0.7rem;
		border-left: 2px solid color-mix(in srgb, var(--accent) 45%, transparent);
		font-size: 0.98rem;
		font-style: italic;
	}

	@media (max-width: 480px) {
		.sentence {
			font-size: 1.22rem;
		}
	}

	/* Mirrors `PromptHeader`'s `.prompt.md` bump — the sentence plays the same
	   role here, just laid out as this component's own interactive line
	   instead of through the shared block (see the component note above). */
	@media (min-width: 72rem) {
		.sentence {
			font-size: 1.65rem;
		}
	}
</style>
