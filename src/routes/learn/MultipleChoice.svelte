<!--
  Multiple choice: four big tap targets, one right.

  Grading is a plain index comparison — no fuzzy matching, because the learner
  did not produce the string, they picked it. That also means this type can
  never return 'almost'.

  Keyboard: 1-4 select, Enter checks. Selecting does not submit; a wrong tap
  should always be recoverable before committing.

  **Listening mode** is a second presentation of the *same* stored challenge,
  not a second type: when the prompt is target-language text (`toNative`), some
  of these are played rather than shown, and the text stays hidden until the
  learner asks for it. Nothing about the challenge changes — which is the point:
  every recognize-MC row already in the pool can be served this way, however
  long ago it was generated, and grading is untouched.

  It is always skippable, in every sense. "Show text" is visible from the first
  frame, one tap turns the challenge back into an ordinary reading one, the mode
  is off entirely for learners who switch it off in Settings, and any sign that
  audio did not happen — speech unavailable, a synth that never produced a
  sound, one that is taking too long — reveals the text on its own. Sound never
  blocks gameplay.
-->
<script lang="ts">
	import type { AnswerEvent } from '$lib/session/engine';
	import { isListeningChallenge } from '$lib/session/engine';
	import { speak, ttsAvailable } from '$lib/tts';
	import type { MultipleChoiceChallenge } from '$lib/types';
	import { getListeningMode, getShowRomanization } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = ''
	}: {
		challenge: MultipleChoiceChallenge;
		onanswer: (event: AnswerEvent) => void;
		targetLanguage?: string;
	} = $props();

	/** Read once — the toggles live in Settings, not mid-session. */
	const showRomanization = getShowRomanization();
	const listeningEnabled = getListeningMode();

	/**
	 * `speak()` resolves quietly on every failure — deliberately, and it leaves
	 * no error to catch. So "did the learner actually hear anything?" is inferred
	 * from the clock instead: a real clip of a word or phrase takes longer than
	 * this to play, so anything faster means nothing came out.
	 */
	const MIN_AUDIBLE_MS = 250;

	/**
	 * How long to wait for audio before giving up and showing the text. Generous
	 * enough for a synth warming up, short enough that a first-run Kokoro model
	 * download (minutes) cannot strand the learner in front of a blank prompt.
	 */
	const AUDIO_TIMEOUT_MS = 6000;

	/** Reset per challenge: `challenge.id` is the tracked read. */
	let selected = $state<number | null>(null);
	let locked = $state(false);
	let shownAt = $state(Date.now());
	/** The learner — or a failure — asked for the prompt text. */
	let revealed = $state(false);

	/**
	 * Audio-first for this particular challenge. Three independent gates: the
	 * engine's share-of-eligible rule, the learner's preference, and whether
	 * speech can produce anything at all on this device.
	 */
	const listening = $derived(
		isListeningChallenge(challenge, listeningEnabled) && ttsAvailable(targetLanguage)
	);

	/** True while the prompt is withheld — the only thing listening mode changes. */
	const hidingPrompt = $derived(listening && !revealed && !locked);

	$effect(() => {
		void challenge.id;
		selected = null;
		locked = false;
		revealed = false;
		shownAt = Date.now();
	});

	/**
	 * Plays the prompt once per challenge, and reveals the text if that plainly
	 * did not work. Runs only for listening challenges; every other challenge is
	 * as silent here as it was before (the feedback banner owns answer audio).
	 */
	$effect(() => {
		const prompt = challenge.prompt;
		if (!listening) return;

		let cancelled = false;
		const timer = setTimeout(() => {
			if (!cancelled) revealed = true;
		}, AUDIO_TIMEOUT_MS);

		const startedAt = Date.now();
		void speak(prompt, targetLanguage).then(() => {
			if (cancelled) return;
			clearTimeout(timer);
			// Nothing audible happened; do not leave the learner staring at silence.
			if (Date.now() - startedAt < MIN_AUDIBLE_MS) revealed = true;
		});

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	const askedIn = $derived(
		challenge.instruction ??
			(hidingPrompt
				? 'Listen — what does this mean?'
				: challenge.direction === 'toTarget'
					? 'Pick the translation'
					: 'What does this mean?')
	);

	/**
	 * The prompt is in the target language when the learner is translating
	 * *out* of it. Options are only worth a speaker button in the other
	 * direction, and four of them would be noise — the feedback banner reads
	 * the right answer aloud instead.
	 */
	const promptIsTarget = $derived(challenge.direction === 'toNative');

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
	<p class="prompt">
		{#if hidingPrompt}
			<span class="hidden-prompt" aria-hidden="true">· · ·</span>
		{:else}
			<span>{challenge.prompt}</span>
		{/if}
		{#if promptIsTarget}
			<SpeakButton
				text={challenge.prompt}
				lang={targetLanguage}
				label={hidingPrompt ? 'Play again' : ''}
			/>
		{/if}
	</p>
	{#if showRomanization && challenge.promptRomanization && !hidingPrompt}
		<p class="rom">{challenge.promptRomanization}</p>
	{/if}

	{#if listening}
		<!-- Always rendered, never only after a failure: the escape hatch has to
		     be there before the learner needs it. -->
		<button
			type="button"
			class="btn btn-ghost reveal"
			disabled={!hidingPrompt}
			onclick={() => (revealed = true)}
		>
			{hidingPrompt ? 'Show text' : 'Text shown'}
		</button>
	{/if}

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
				<span class="label">
					<span>{option}</span>
					{#if showRomanization && challenge.optionsRomanization?.[index]}
						<span class="rom">{challenge.optionsRomanization[index]}</span>
					{/if}
				</span>
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
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 1.5rem;
		font-size: 1.9rem;
		font-weight: 800;
		line-height: 1.15;
		letter-spacing: -0.015em;
		overflow-wrap: anywhere;
	}

	.prompt > span {
		min-width: 0;
	}

	/* When romanization follows the prompt, it owns the trailing space instead. */
	.prompt:has(+ :global(.rom)) {
		margin-bottom: 0.2rem;
	}

	.prompt + :global(.rom) {
		margin-bottom: 1.3rem;
		font-size: 1rem;
	}

	/* A placeholder with the same weight as the prompt, so revealing the text
	   does not shove the options down the page. */
	.hidden-prompt {
		color: var(--text-muted);
		letter-spacing: 0.15em;
	}

	.reveal {
		align-self: flex-start;
		margin: 0 0 1.1rem;
		padding: 0.45rem 0.85rem;
		font-size: 0.82rem;
	}

	.reveal:disabled {
		opacity: 0.45;
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
