<!--
  Target-language text with its reading printed over it, per token.

  The other way to show a romanization is the `.rom` line: one muted string
  under the whole sentence, which is all a stored LLM `reading` can be. This
  block is what a *local* romanizer (`$lib/romanize`) buys — the reading sits
  over the word it belongs to, so the eye can check one character instead of
  re-reading a whole second line, and any subset of the words can go bare
  (that is `applyPlan`'s doing, not this block's).

  **Deliberately dumb.** It renders exactly the tokens it is handed: a token
  with a `reading` becomes a `<ruby>`, one without becomes plain text. No
  preference lives here — callers pass tokens whose hidden readings have already
  been nulled by `$lib/session/romanization`'s `applyPlan`, so "the learner owns
  this word" and "this span is punctuation" arrive as the same thing, a token
  with no reading, and both render as bare text.

  A `<ruby>` with an empty `<rt>` is not the same as no ruby: it still reserves
  the annotation line and shifts the baseline. So the null case emits no ruby at
  all, which is what keeps a half-annotated sentence sitting on one straight
  line.

  The markup is written **without whitespace between tokens** — one long line
  rather than a formatted block — because the tokens reproduce the source text
  character for character, spaces included, and a newline in the template would
  become a rendered space between every pair of them.
-->
<script lang="ts">
	import type { RomanizedToken } from '$lib/romanize';

	let {
		tokens
	}: {
		/**
		 * The text, tokenized and annotated. Concatenating every `text` gives back
		 * the original string, so this renders as the same text either way.
		 */
		tokens: RomanizedToken[];
	} = $props();
</script>

<span class="ruby-text"
	>{#each tokens as token, index (index)}{#if token.reading}<ruby
				>{token.text}<rt>{token.reading}</rt></ruby
			>{:else}{token.text}{/if}{/each}</span
>

<style>
	/*
	  Inline, so a ruby prompt flows inside whatever line it was dropped into —
	  a flex prompt row, a sentence with a gap in it, the label of a tap target.
	  `min-width: 0` earns its place where that parent is a flex container: the
	  block is often the flex item, and without it a long sentence pushes the
	  speaker button off the row instead of wrapping.
	*/
	.ruby-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/*
	  Ruby needs room above the line that a tight display line-height does not
	  leave, and the prompt line is set at 1.2. Relaxing it here — on the ruby
	  run only — keeps annotated and unannotated lines from colliding without
	  loosening every prompt in the app.
	*/
	.ruby-text :global(ruby) {
		ruby-position: over;
		ruby-align: center;
		line-height: 1.9;
	}

	/*
	  The annotation, wearing the same clothes as `.rom` (app.css): body face,
	  muted ink, a touch of tracking. It is a gloss on the specimen, never the
	  specimen — so it never inherits the display face, the weight or the
	  `SOFT` axis of the text it sits over.

	  Sized in `em` so it scales with whatever it annotates — but clamped, because
	  pinyin legibility lives in the tone marks, and below ~0.7rem ā/á/ǎ/à stop
	  being distinguishable, which makes the annotation worse than none. Half of a
	  1.9rem prompt clears the floor and keeps its proportion; half of a 1rem
	  option card does not, and takes the floor instead. `user-select: none` keeps
	  a copied sentence free of pinyin interleaved through it.
	*/
	.ruby-text :global(rt) {
		font-family: var(--font);
		font-size: max(0.5em, 0.72rem);
		font-weight: 500;
		font-variation-settings: normal;
		letter-spacing: 0.02em;
		line-height: 1.2;
		color: var(--text-muted);
		user-select: none;
	}
</style>
