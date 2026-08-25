<!--
  Word order: build the sentence out of shuffled tiles.

  A native-language prompt, a tray the learner fills, and a bank of tiles below
  it. Tapping a bank tile appends it to the tray; tapping a tray tile takes it
  back out. Nothing submits on its own — a misplaced tap must always be
  recoverable before committing, exactly as in multiple choice.

  Grading compares the *texts* the learner arranged to `answerTokens`, never the
  tile indices they came from. That is what keeps a sentence using the same word
  twice (or a distractor that happens to read like a real tile) from failing an
  arrangement that is, on the page, exactly right. It is an exact comparison and
  never 'almost': the learner chose from a closed set rather than spelling
  anything, so there is no typo to be generous about.

  The tray is joined for display with `joinTokens`, the same helper the resolver
  used to build `challenge.answer` — so what the learner reads back is assembled
  by the same rule as the answer it is graded against, spaces or no spaces.
-->
<script lang="ts">
	import type { ChallengeProps } from '$lib/challenges/props';
	import { isPunctuationOnly, joinTokens } from '$lib/text';
	import type { WordOrderChallenge } from '$lib/types';
	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import CheckButton from './blocks/CheckButton.svelte';
	import PromptHeader from './blocks/PromptHeader.svelte';
	import TapOption from './blocks/TapOption.svelte';
	import TapRow from './blocks/TapRow.svelte';

	// Both languages are offered to every challenge component; this one needs
	// neither — the prompt is native, the tiles are target, and both are printed
	// rather than spoken.
	let { challenge, onanswer, showReadings = true }: ChallengeProps<WordOrderChallenge> = $props();

	/**
	 * Tile *positions* the learner has placed, in the order they placed them.
	 * Positions rather than texts, so two tiles reading the same word stay two
	 * distinct tiles on screen; the texts behind them are what grading uses.
	 */
	let placed = $state<number[]>([]);

	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			placed = [];
		}
	);

	const bank = $derived(
		challenge.tiles
			.map((text, index) => ({ index, text }))
			.filter((tile) => !placed.includes(tile.index))
	);

	const chosen = $derived(placed.map((index) => challenge.tiles[index]));
	const sentence = $derived(joinTokens(chosen));
	const ready = $derived(placed.length > 0 && !lock.locked);

	const askedIn = $derived(challenge.instruction ?? 'Put the words in order');

	function readingOf(index: number): string {
		return (showReadings ? challenge.tilesRomanization?.[index] : '') ?? '';
	}

	function place(index: number): void {
		if (lock.locked || placed.includes(index)) return;
		placed = [...placed, index];
	}

	function remove(position: number): void {
		if (lock.locked) return;
		placed = placed.filter((_, at) => at !== position);
	}

	/**
	 * Exact sequence equality, by text. See the component note.
	 *
	 * Punctuation-only tiles are ignored on both sides: the resolver no longer
	 * produces them, but rows generated before it merged punctuation into its
	 * neighbouring word still carry tiles like "？" — and forgetting one is not
	 * a language mistake worth failing the arrangement over.
	 */
	function isCorrect(): boolean {
		const chosenWords = chosen.filter((text) => !isPunctuationOnly(text));
		const answerWords = challenge.answerTokens.filter((text) => !isPunctuationOnly(text));
		if (chosenWords.length !== answerWords.length) return false;
		return chosenWords.every((text, at) => text === answerWords[at]);
	}

	function submit(): void {
		if (!ready) return;
		onanswer({
			answerGiven: sentence,
			verdict: isCorrect() ? 'correct' : 'wrong',
			responseMs: lock.commit()
		});
	}

	function onFormSubmit(event: SubmitEvent): void {
		event.preventDefault();
		submit();
	}
</script>

<form class="word-order" onsubmit={onFormSubmit}>
	<PromptHeader kicker={askedIn} prompt={challenge.prompt} size="md" />

	<div class="tray" class:empty={placed.length === 0} aria-label="Your sentence">
		{#if placed.length === 0}
			<span class="tray-hint">Tap the words below</span>
		{:else}
			{#each placed as index, position (position)}
				<TapOption
					text={challenge.tiles[index]}
					reading={readingOf(index)}
					state="selected"
					disabled={lock.locked}
					label={`Remove ${challenge.tiles[index]}`}
					onclick={() => remove(position)}
				/>
			{/each}
		{/if}
	</div>

	<div class="bank">
		<p class="bank-label">Word bank</p>
		<hr class="stitch" />
		<TapRow label="Available words">
			{#each bank as tile (tile.index)}
				<TapOption
					text={tile.text}
					reading={readingOf(tile.index)}
					disabled={lock.locked}
					onclick={() => place(tile.index)}
				/>
			{/each}
		</TapRow>
	</div>

	<CheckButton type="submit" disabled={!ready} />
</form>

<style>
	.word-order {
		display: flex;
		flex-direction: column;
	}

	/*
	  The slot the sentence gets written into: tinted paper inside a stitched
	  frame, closed at the foot by a solid rule the tiles sit on. The dashed
	  frame is the app's one motif doing the job it does everywhere else —
	  marking a space that is waiting to be filled in.
	*/
	.tray {
		display: flex;
		flex-wrap: wrap;
		align-content: flex-start;
		gap: 0.55rem;
		min-height: 5.5rem;
		margin-bottom: 1.4rem;
		padding: 0.7rem;
		border: 1px dashed var(--border-strong);
		border-bottom: 3px solid var(--border-strong);
		border-radius: var(--radius) var(--radius) 0 0;
		background: color-mix(in srgb, var(--surface-alt) 60%, transparent);
		transition: border-color 0.2s ease;
	}

	.tray:not(.empty) {
		border-bottom-color: var(--accent);
	}

	.tray.empty {
		display: grid;
		place-items: center;
	}

	.tray-hint {
		color: var(--text-muted);
		font-size: 0.88rem;
		font-weight: 500;
		font-style: italic;
	}

	.bank {
		margin-bottom: 1.5rem;
	}

	.bank-label {
		margin: 0;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.bank-label + .stitch {
		margin: 0.35rem 0 0.8rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.tray {
			transition: none;
		}
	}
</style>
