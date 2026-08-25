<!--
  One tappable answer: an option card, a word tile, a chip, a word in a
  sentence.

  Five challenge types put something tappable on screen and all five had
  reimplemented the same button — the border, the press, the accent-soft
  selected state, the reading underneath, the disabled dimming — drifting on
  padding, transition lists and disabled opacity in ways nobody chose. The skin
  itself lives in `.tap` (app.css); everything that distinguishes one tap
  target from another lives here, as three sizes and five states, so a type
  picks a shape rather than restyling a button.

  `size` is the shape:
  - `card` — a full-width option row, optionally numbered. Multiple choice.
  - `tile` — a shrink-to-fit word. Cloze chips, word-order tiles, match tiles.
  - `inline` — a word *inside a sentence* rather than a card: no visible frame,
    a dashed underline standing in for the missing word, and inverted surfaces
    so the word lifts out of the line on hover instead of sinking into it. The
    press is a 1px nudge with no border collapse, because a 4px bottom border
    would read as an underline it does not have. Spot-the-error.

  `state` is what the learner has done to it. `selected` is a pick that can
  still be taken back, `correct` a pair that has locked in, `wrong` the half
  second a bad pair spends being wrong, `spent` a chip whose word is currently
  sitting somewhere else on screen. `wrong` shakes on its own; `pop` is the
  separate one-shot beat a freshly matched tile plays over `correct`.

  The reading comes in one of two shapes, and only one of them is ever used:
  `reading`, the stored sentence-wide string printed under the word, or
  `tokens`, a local romanizer's per-token annotation printed *over* it. Tokens
  win where they exist. Both stay the caller's decision — a tap target renders
  what it is handed.
-->
<script lang="ts">
	import type { RomanizedToken } from '$lib/romanize';

	import RubyText from './RubyText.svelte';

	let {
		text,
		reading = '',
		tokens = null,
		badge,
		state = 'idle',
		size = 'tile',
		align = 'center',
		fill = false,
		pop = false,
		disabled = false,
		selection = 'none',
		label = '',
		onclick
	}: {
		/** The word or phrase on the button. */
		text: string;
		/** Its Latin reading, or `''`. The caller applies the learner's setting. */
		reading?: string;
		/**
		 * The same text, tokenized and annotated by a local romanizer, or `null`
		 * where there is none for this language. Non-null replaces both {@link
		 * text} and {@link reading} with one ruby run.
		 */
		tokens?: RomanizedToken[] | null;
		/**
		 * The keyboard digit that picks this option. Rendered as a badge, hidden
		 * on touch pointers where it means nothing.
		 */
		badge?: number;
		state?: 'idle' | 'selected' | 'correct' | 'wrong' | 'spent';
		size?: 'card' | 'tile' | 'inline';
		/** `start` left-aligns the content; numbered cards want it. */
		align?: 'start' | 'center';
		/** Stretch to the container and take a comfortable minimum height. */
		fill?: boolean;
		/** Play the "that was right" pop once. */
		pop?: boolean;
		disabled?: boolean;
		/**
		 * How the button reports its selected-ness to assistive tech: `radio` for
		 * one-of-N inside a `radiogroup`, `toggle` for an independently pressable
		 * tile, `none` where picking it moves it somewhere else instead.
		 */
		selection?: 'radio' | 'toggle' | 'none';
		/** An explicit accessible name, where the text alone is not the action. */
		label?: string;
		onclick: () => void;
	} = $props();

	const picked = $derived(state === 'selected');
</script>

<button
	type="button"
	class="opt tap {size}"
	class:fill
	class:start={align === 'start'}
	class:selected={state === 'selected'}
	class:correct={state === 'correct'}
	class:wrong={state === 'wrong'}
	class:spent={state === 'spent'}
	class:ll-shake={state === 'wrong'}
	class:ll-pop={pop}
	role={selection === 'radio' ? 'radio' : undefined}
	aria-checked={selection === 'radio' ? picked : undefined}
	aria-pressed={selection === 'toggle' ? picked : undefined}
	aria-label={label || undefined}
	{disabled}
	{onclick}
>
	{#if badge !== undefined}
		<span class="key" aria-hidden="true">{badge}</span>
	{/if}
	<span class="label">
		{#if tokens && tokens.length > 0}
			<RubyText {tokens} />
		{:else}
			<span>{text}</span>
			{#if reading !== ''}
				<span class="rom">{reading}</span>
			{/if}
		{/if}
	</span>
</button>

<style>
	/* Border, press, hover and focus ring come from `.tap` in app.css. */
	.opt {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.85rem;
		min-width: 0;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.opt.start {
		justify-content: flex-start;
		text-align: left;
	}

	.opt.fill {
		width: 100%;
		min-height: 3.4rem;
	}

	.label {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* Hanzi need more pixels than Latin at the same point size — the strokes of
	   银 close up where an `a` stays open — so an annotated label sets its
	   specimen at 115%, the modest upsize Chinese print gives characters sitting
	   in Latin body text. Riding on the ruby wrapper keeps it exactly scoped:
	   the wrapper only exists for target-language text with a local romanizer,
	   so Latin labels never move. */
	.label > :global(.ruby-text) {
		font-size: 1.15em;
	}

	/* Sizes ---------------------------------------------------------------- */

	.opt.card {
		width: 100%;
		padding: 1rem 1.1rem;
		font-size: 1.05rem;
	}

	.opt.tile {
		padding: 0.65rem 0.95rem;
	}

	.opt.inline {
		padding: 0.45rem 0.7rem;
		border-color: transparent;
		border-bottom: 3px dashed var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
		/* A word inside a sentence reads with the sentence, so it takes the
		   display face the challenge prompt already wears. */
		font-family: var(--font-display);
		font-size: 1.3rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
	}

	.opt.inline:hover:not(:disabled) {
		background: var(--surface);
	}

	/* No border collapse here; see the component note. */
	.opt.inline:active:not(:disabled) {
		transform: translateY(1px);
		border-bottom-width: 3px;
	}

	/* The reading sits under its own word, so a long sentence still lines up.
	   Back to the body face: the reading is an annotation, not the specimen. */
	.opt.inline .rom {
		font-family: var(--font);
		font-size: 0.72rem;
		font-weight: 500;
	}


	/* States --------------------------------------------------------------- */

	/* Before the state rules on purpose: a locked-in `correct` tile and a
	   `spent` chip both want to recede further than a merely disabled one. */
	.opt:disabled {
		cursor: default;
		opacity: 0.75;
	}

	.opt.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.opt.inline.selected {
		border-bottom-style: solid;
	}

	.opt.correct {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--primary-strong);
		opacity: 0.6;
		cursor: default;
	}

	/*
	  The shake itself is `.ll-shake` from app.css — one definition, one
	  reduced-motion opt-out. The danger colours are separate on purpose:
	  reduced motion drops the movement and keeps them.
	*/
	.opt.wrong {
		border-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 14%, transparent);
		color: var(--danger);
	}

	/* The chip whose word is currently in the gap: still there, clearly spent. */
	.opt.spent {
		border-style: dashed;
		border-bottom-width: 2px;
		opacity: 0.35;
	}

	/* Keyboard badge ------------------------------------------------------- */

	/* A pencilled index number in the margin of the entry: hairline frame, the
	   same 6px squircle the inputs wear, figures on the tabular grid. */
	.key {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 1.7rem;
		height: 1.7rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-alt) 70%, transparent);
		font-size: 0.78rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		transition:
			border-color 0.12s ease,
			background 0.12s ease,
			color 0.12s ease;
	}

	.opt.selected .key {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--accent);
	}

	/* The number badges are a keyboard affordance; useless on touch. */
	@media (pointer: coarse) {
		.key {
			display: none;
		}
	}

	@media (max-width: 480px) {
		.opt.card {
			padding: 0.85rem 0.9rem;
			font-size: 1rem;
		}

		.opt.tile {
			padding: 0.55rem 0.8rem;
			font-size: 0.95rem;
		}

		.opt.inline {
			padding: 0.4rem 0.55rem;
			font-size: 1.1rem;
		}
	}
</style>
