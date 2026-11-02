<!--
  One word's card, the reader's and the page viewer's alike: drawn here,
  decided by the route. It emits — look up, add, unmark, close — and the
  route makes the calls and the writes; the meaning and reading fields are
  bound back so the route files exactly what the learner left in them.

  What it shows follows the word's status (`reading.md`): a tracked word its
  gloss and nothing to do; any other word "What does this mean?" until it has
  a looked-up answer (primary until the learner has typed a meaning, when Add
  takes over), the lookup's explanation read-only above the always-editable
  Meaning and — for a word not in Latin script — Reading fields, then Add, and
  Unmark beside it for a legacy known mark when the route offers one.

  `compact` is the popover's: the explanation folds under "More" so the card
  stays small beside the word. Skinless — the popover or the sheet around it
  paints the surface. The control a popover should focus first wears
  `data-autofocus`.
-->
<script module lang="ts">
	import type { Maturity } from '$lib/challenges/serve';

	/** The garden's own bed names, so one word means one thing across the app. */
	export const BEDS: Record<Maturity, string> = {
		new: 'sprouting',
		young: 'growing',
		solid: 'rooted'
	};
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	import SpeakButton from './SpeakButton.svelte';

	interface Props {
		term: string;
		/** The reading shown beside the term. */
		reading?: string;
		lang?: string;
		status: 'tracked' | 'known' | 'plain';
		statusLine: string;
		/** A tracked word's gloss. */
		meaning?: string;
		/** The lookup's longer answer: read, never filed. */
		explanation?: string;
		/** The word has a looked-up answer, so there is nothing left to ask. */
		answered: boolean;
		/** Offer a Reading field (the word is not in Latin script). */
		offersReading: boolean;
		meaningDraft: string;
		readingDraft: string;
		nativeLanguage?: string;
		lookingUp: boolean;
		writing: boolean;
		error?: string;
		/** A receipt line after an add. */
		note?: string;
		compact?: boolean;
		/** Drawn above the head — the page viewer's larger line on a phone. */
		context?: Snippet;
		onlookup: () => void;
		onadd: () => void;
		/** Offered on a legacy known word only when given. */
		onunmark?: () => void;
		onclose: () => void;
	}

	let {
		term,
		reading,
		lang,
		status,
		statusLine,
		meaning,
		explanation,
		answered,
		offersReading,
		meaningDraft = $bindable(),
		readingDraft = $bindable(),
		nativeLanguage,
		lookingUp,
		writing,
		error,
		note,
		compact = false,
		context,
		onlookup,
		onadd,
		onunmark,
		onclose
	}: Props = $props();

	const draft = $derived(meaningDraft.trim());
</script>

{#if context}{@render context()}{/if}

<div class="word-head">
	<div class="word-id">
		<p class="word-term" {lang}>{term}</p>
		{#if reading}<span class="rom">{reading}</span>{/if}
	</div>
	<SpeakButton text={term} {lang} />
	<button
		type="button"
		class="close"
		aria-label="Close"
		data-autofocus={status === 'tracked' ? '' : undefined}
		onclick={onclose}
	>
		<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
			<path d="m7 7 10 10M17 7 7 17" />
		</svg>
	</button>
</div>

<p class="word-status">{statusLine}</p>

<!-- An untracked word's meaning is in its field below, where it can be
     corrected before it is filed; shown here too, it would be said twice. -->
{#if meaning && status === 'tracked'}
	<p class="word-meaning">{meaning}</p>
{/if}

<!-- The lookup's longer answer: read-only, above the Meaning field it
     explains, which holds only the short gloss that gets filed. -->
{#if explanation}
	{#if compact}
		<details class="more">
			<summary>More</summary>
			<p class="word-explanation">{explanation}</p>
		</details>
	{:else}
		<p class="word-explanation">{explanation}</p>
	{/if}
{/if}

<!-- A tracked word has no actions here: the garden is where it is managed. -->
{#if status !== 'tracked'}
	<hr class="stitch" />
	<!-- Paid, so only on a press. Primary until the learner has a meaning of
	     their own in the field; gone once answered. -->
	{#if !answered}
		<button
			type="button"
			class="btn btn-block ask"
			class:btn-primary={draft === ''}
			class:btn-ghost={draft !== ''}
			data-autofocus={draft === '' ? '' : undefined}
			disabled={lookingUp}
			aria-busy={lookingUp}
			onclick={onlookup}
		>
			{lookingUp ? 'Looking it up…' : 'What does this mean?'}
		</button>
	{/if}
	<!-- Always editable, lookup or not, in flight or failed: the answer is a
	     suggestion, and a learner who knows the word types it and adds it. -->
	<div class="word-fields">
		<label class="field">
			<span class="label">Meaning</span>
			<input
				class="input"
				type="text"
				placeholder="In {nativeLanguage ?? 'your language'}"
				disabled={writing}
				bind:value={meaningDraft}
				onkeydown={(event) => {
					if (event.key === 'Enter') onadd();
				}}
			/>
		</label>
		{#if offersReading}
			<label class="field">
				<span class="label">Reading</span>
				<input
					class="input"
					type="text"
					placeholder="In Latin letters"
					disabled={writing}
					bind:value={readingDraft}
					onkeydown={(event) => {
						if (event.key === 'Enter') onadd();
					}}
				/>
			</label>
		{/if}
	</div>
	<div class="word-actions">
		<button
			type="button"
			class="btn"
			class:btn-primary={draft !== ''}
			class:btn-ghost={draft === ''}
			data-autofocus={draft !== '' || answered ? '' : undefined}
			disabled={writing || draft === ''}
			onclick={onadd}
		>
			Add to my words
		</button>
		{#if status === 'known' && onunmark}
			<button type="button" class="btn btn-ghost" disabled={writing} onclick={onunmark}>
				Unmark
			</button>
		{/if}
	</div>
{/if}

{#if error}
	<p class="error" role="alert">{error}</p>
{/if}
{#if note}
	<p class="note" aria-live="polite">{note}</p>
{/if}

<style>
	.ico {
		width: 1.2rem;
		height: 1.2rem;
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.word-head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.word-id {
		flex: 1 1 auto;
		min-width: 0;
	}

	.word-term {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.4rem;
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close:hover {
		border-color: var(--border);
		background: var(--surface-alt);
		color: var(--text);
	}

	.close:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.word-status {
		margin: 0.5rem 0 0;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.word-meaning {
		margin: 0.3rem 0 0;
		font-size: 1.02rem;
		line-height: 1.45;
	}

	/* Prose, muted a step so the editable gloss below stays the thing to act on. */
	.word-explanation {
		margin: 0.5rem 0 0;
		font-size: 0.95rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.more {
		margin-top: 0.4rem;
	}

	.more summary {
		width: fit-content;
		color: var(--text-muted);
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
	}

	.more .word-explanation {
		margin-top: 0.3rem;
		font-size: 0.9rem;
	}

	.stitch {
		margin: 0.9rem 0;
	}

	/* The card's question, a full row of its own above the fields it fills. */
	.ask {
		margin-bottom: 0.85rem;
		padding: 0.7rem 1rem;
	}

	/* Meaning and reading stacked; the card is one column at every width. */
	.word-fields {
		display: grid;
		gap: 0.6rem;
		margin-bottom: 0.85rem;
	}

	.word-fields .field {
		margin: 0;
	}

	.word-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.word-actions .btn {
		flex: 1 1 9rem;
		padding: 0.65rem 1rem;
		font-size: 0.88rem;
	}

	.error {
		margin: 0.75rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.note {
		margin: 0.75rem 0 0;
		color: var(--primary-strong);
		font-size: 0.88rem;
		font-weight: 700;
	}
</style>
