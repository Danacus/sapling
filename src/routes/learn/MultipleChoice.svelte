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
	import { choiceKeyAction } from '$lib/challenges/keyboard';
	import type { ChallengeProps } from '$lib/challenges/props';
	import { isListeningChallenge } from '$lib/session/engine';
	import { speak, ttsAvailable } from '$lib/tts';
	import type { MultipleChoiceChallenge } from '$lib/types';
	import { getListeningMode } from '$lib/ui/prefs';
	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import CheckButton from './blocks/CheckButton.svelte';
	import PromptHeader from './blocks/PromptHeader.svelte';
	import TapOption from './blocks/TapOption.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		showReadings = true
	}: ChallengeProps<MultipleChoiceChallenge> = $props();

	/** Read once — the toggle lives in Settings, not mid-session. */
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

	let selected = $state<number | null>(null);
	/** The learner — or a failure — asked for the prompt text. */
	let revealed = $state(false);

	// Declared before the audio effect below, so a challenge swap clears
	// `revealed` before the new prompt gets its chance to set it again.
	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			selected = null;
			revealed = false;
		}
	);

	/**
	 * Audio-first for this particular challenge. Three independent gates: the
	 * engine's share-of-eligible rule, the learner's preference, and whether
	 * speech can produce anything at all on this device.
	 */
	const listening = $derived(
		isListeningChallenge(challenge, listeningEnabled) && ttsAvailable(targetLanguage)
	);

	/** True while the prompt is withheld — the only thing listening mode changes. */
	const hidingPrompt = $derived(listening && !revealed && !lock.locked);

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

	function readingOf(index: number): string {
		return (showReadings ? challenge.optionsRomanization?.[index] : '') ?? '';
	}

	function select(index: number): void {
		if (lock.locked) return;
		selected = index;
	}

	function submit(): void {
		if (lock.locked || selected === null) return;
		onanswer({
			answerGiven: challenge.options[selected],
			verdict: selected === challenge.correctIndex ? 'correct' : 'wrong',
			responseMs: lock.commit()
		});
	}

	/** Digits 1-4 pick, Enter checks; the rule itself is in `$lib/challenges`. */
	function onkeydown(event: KeyboardEvent): void {
		const action = choiceKeyAction(event, {
			count: challenge.options.length,
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

<div class="mc">
	<PromptHeader
		kicker={askedIn}
		prompt={challenge.prompt}
		reading={(showReadings ? challenge.promptRomanization : '') ?? ''}
		hidePrompt={hidingPrompt}
		speakText={promptIsTarget ? challenge.prompt : ''}
		speakLang={targetLanguage}
		speakLabel={hidingPrompt ? 'Play again' : ''}
	/>

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
			<TapOption
				text={option}
				reading={readingOf(index)}
				badge={index + 1}
				size="card"
				align="start"
				selection="radio"
				state={selected === index ? 'selected' : 'idle'}
				disabled={lock.locked}
				onclick={() => select(index)}
			/>
		{/each}
	</div>

	<CheckButton disabled={selected === null || lock.locked} onclick={submit} />
</div>

<style>
	.mc {
		display: flex;
		flex-direction: column;
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
</style>
