<!--
  Multi-cloze: a short target-language passage with several blanks and one
  shared bank. A bank word is placed once, so the learner has to decide both
  which word fits and which gap it belongs in; the component returns an
  item-level verdict for every gap while keeping one intuitive overall result.
-->
<script lang="ts">
	import { ALL_READINGS, rubyFor, storedReading, type ChallengeProps } from '$lib/challenges/props';
	import {
		completedMultiClozePassage,
		gradeMultiClozeAnswers,
		serializeMultiClozeAnswers
	} from '$lib/challenges/types/multi-cloze';
	import type { RomanizedToken } from '$lib/romanize';
	import { visibleBank } from '$lib/session/support';
	import type { MultiClozeChallenge } from '$lib/types';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import RubyText from '$lib/ui/RubyText.svelte';

	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import CheckButton from './blocks/CheckButton.svelte';
	import PromptHeader from './blocks/PromptHeader.svelte';
	import TapOption from './blocks/TapOption.svelte';
	import WordBank from './blocks/WordBank.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		readings = ALL_READINGS,
		bankSize,
		tokenize = null
	}: ChallengeProps<MultiClozeChallenge> = $props();

	const ruby = $derived(rubyFor(tokenize, readings));
	/**
	 * The stored bank positions this served challenge shows — every position
	 * when `bankSize` was not supplied, so a bare render (tests) keeps showing
	 * everything stored.
	 */
	const visibleIndices = $derived(visibleBank(challenge, bankSize ?? challenge.wordBank.length));
	const bank = $derived(visibleIndices.map((index) => challenge.wordBank[index]));
	let assignments = $state<(number | null)[]>([]);
	let activeGap = $state(0);

	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			assignments = Array.from({ length: challenge.gaps.length }, () => null);
			activeGap = 0;
		}
	);

	type PassagePart = { text: string } | { gap: number };
	const passageParts = $derived.by(() => {
		const parts: PassagePart[] = [];
		const markers = /___(\d+)___/g;
		let cursor = 0;
		for (const match of challenge.passage.matchAll(markers)) {
			const at = match.index ?? cursor;
			if (at > cursor) parts.push({ text: challenge.passage.slice(cursor, at) });
			const gap = Number(match[1]) - 1;
			if (gap >= 0 && gap < challenge.gaps.length) parts.push({ gap });
			else parts.push({ text: match[0] });
			cursor = at + match[0].length;
		}
		if (cursor < challenge.passage.length) parts.push({ text: challenge.passage.slice(cursor) });
		return parts;
	});

	const answers = $derived(assignments.map((index) => (index === null ? '' : (bank[index] ?? ''))));
	const ready = $derived(answers.every((answer) => answer !== '') && !lock.locked);
	const completedPassage = $derived(completedMultiClozePassage(challenge));
	const spokenPassage = $derived(
		lock.locked ? completedPassage : challenge.passage.replace(/___\d+___/g, '…')
	);

	function tokensFor(text: string): RomanizedToken[] | null {
		return ruby(text);
	}

	function readingFor(index: number): string {
		return storedReading(readings, challenge.wordBankRomanization?.[visibleIndices[index]]);
	}

	function usedBy(index: number): number | undefined {
		const gap = assignments.indexOf(index);
		return gap < 0 ? undefined : gap;
	}

	function chooseGap(index: number): void {
		if (lock.locked) return;
		activeGap = index;
	}

	function clearGap(index: number): void {
		if (lock.locked || assignments[index] === null) return;
		assignments = assignments.map((value, at) => (at === index ? null : value));
		activeGap = index;
	}

	function placeWord(wordIndex: number): void {
		if (lock.locked) return;
		const next = [...assignments];
		const previousGap = next.indexOf(wordIndex);
		if (previousGap >= 0) next[previousGap] = null;
		next[activeGap] = wordIndex;
		assignments = next;
		const nextGap = next.findIndex((entry) => entry === null);
		if (nextGap >= 0) activeGap = nextGap;
	}

	function submit(): void {
		if (!ready) return;
		const graded = gradeMultiClozeAnswers(challenge, answers);
		onanswer({
			answerGiven: serializeMultiClozeAnswers(answers),
			verdict: graded.verdict,
			itemVerdicts: graded.itemVerdicts,
			responseMs: lock.commit()
		});
	}

	function onFormSubmit(event: SubmitEvent): void {
		event.preventDefault();
		submit();
	}
</script>

<form class="multi-cloze" onsubmit={onFormSubmit}>
	<PromptHeader kicker="Complete the passage" />

	<p class="passage">
		{#each passageParts as part, index (index)}
			{#if 'text' in part}
				{#if tokensFor(part.text)}
					<RubyText tokens={tokensFor(part.text) ?? []} />
				{:else}
					<span>{part.text}</span>
				{/if}
			{:else}
				{@const answer = answers[part.gap]}
				<button
					type="button"
					class="gap"
					class:active={activeGap === part.gap}
					class:filled={answer !== ''}
					disabled={lock.locked}
					aria-label={answer === '' ? `Blank ${part.gap + 1}` : `Blank ${part.gap + 1}: ${answer}`}
					onclick={() => (answer === '' ? chooseGap(part.gap) : clearGap(part.gap))}
				>
					{#if answer === ''}
						<span aria-hidden="true">{part.gap + 1}</span>
					{:else if tokensFor(answer)}
						<RubyText tokens={tokensFor(answer) ?? []} />
					{:else}
						{answer}
					{/if}
				</button>
			{/if}
		{/each}
		<SpeakButton text={spokenPassage} lang={targetLanguage} />
	</p>

	{#if readings.sentence && challenge.passageRomanization && !tokenize}
		<p class="rom passage-rom">{challenge.passageRomanization}</p>
	{/if}

	<WordBank label="Available words">
		{#each bank as word, index (index)}
			<TapOption
				text={word}
				reading={readingFor(index)}
				tokens={tokensFor(word)}
				state={usedBy(index) === undefined ? 'idle' : 'spent'}
				disabled={lock.locked}
				label={usedBy(index) === undefined
					? `Place ${word}`
					: `${word} is in blank ${(usedBy(index) ?? 0) + 1}`}
				onclick={() => placeWord(index)}
			/>
		{/each}
	</WordBank>

	<CheckButton type="submit" disabled={!ready} />
</form>

<style>
	.multi-cloze {
		display: flex;
		flex-direction: column;
	}

	.passage {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.2rem 0;
		margin: 0 0 0.6rem;
		font-family: var(--font-display);
		font-size: 1.38rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		line-height: 1.65;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.passage :global(.speak) {
		align-self: center;
	}

	.gap {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 3.15rem;
		min-height: 2.1rem;
		margin: 0 0.16rem;
		padding: 0.08rem 0.5rem;
		border: 0;
		border-bottom: 3px dashed var(--border-strong);
		border-radius: var(--radius-sm) var(--radius-sm) 0 0;
		background: var(--surface-alt);
		color: var(--text-muted);
		font: inherit;
		text-align: center;
		cursor: pointer;
	}

	.gap.active {
		border-bottom-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
	}

	.gap.filled {
		border-bottom-style: solid;
		color: var(--text);
	}

	.gap:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.gap:disabled {
		cursor: default;
		opacity: 0.8;
	}

	.passage-rom {
		margin: 0 0 1.3rem;
		font-size: 1rem;
	}

	@media (max-width: 480px) {
		.passage {
			font-size: 1.2rem;
		}
	}

	@media (min-width: 72rem) {
		.passage {
			font-size: 1.55rem;
		}
	}
</style>
