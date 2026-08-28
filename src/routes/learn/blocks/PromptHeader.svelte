<!--
  The top of a challenge: kicker, prompt, reading, speaker.

  Every type opened with some subset of the same four lines, hand-rolled, and
  they had drifted on the details that hold the block together — the line
  height, the space a reading is allowed to steal from the prompt's bottom
  margin, whether the speaker button sits on the text or under it. One block
  owns all of that now, so a new challenge type gets the layout by asking for
  it rather than by copying it.

  The margin dance is the part worth knowing: a prompt normally carries the
  whole gap to whatever follows it, but when a romanization line follows, the
  reading owns that gap instead and the prompt tightens up against it. That is
  what keeps `word · reading` reading as one unit rather than as two. A ruby
  prompt has no line following it — the readings are *in* the prompt — so it
  takes the normal bottom margin and the dance does not apply.

  `hidePrompt` is listening mode's whole footprint here (see MultipleChoice):
  the text is replaced by a placeholder of the same weight — so revealing it
  does not shove the options down the page — and the reading is withheld with
  it, since a romanization gives the word away just as plainly as the script.
  Tokens are withheld by the same gate, and for the same reason: ruby over a
  hidden prompt would be the answer in a different alphabet.
-->
<script lang="ts">
	import type { RomanizedToken } from '$lib/romanize';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';

	import RubyText from './RubyText.svelte';

	let {
		kicker,
		prompt = '',
		promptTokens = null,
		reading = '',
		hidePrompt = false,
		speakText = '',
		speakLang = '',
		speakLabel = '',
		size = 'lg'
	}: {
		/** The uppercase instruction line — "Fill in the blank". Always shown. */
		kicker: string;
		/**
		 * The thing being asked. Empty means the type has no plain-text prompt
		 * (cloze builds an interactive sentence of its own), and the whole line is
		 * left out rather than rendered blank.
		 */
		prompt?: string;
		/**
		 * The same prompt, tokenized and annotated by a local romanizer, or `null`
		 * where there is none for this language. Non-null wins: the prompt renders
		 * as ruby text and {@link reading} is dropped, because the readings are
		 * already sitting over the words they belong to.
		 */
		promptTokens?: RomanizedToken[] | null;
		/**
		 * The prompt's Latin reading, or `''` for none. Callers apply the
		 * learner's romanization preference themselves — this block only renders
		 * what it is handed. The fallback for languages with no local romanizer;
		 * ignored entirely when {@link promptTokens} is given.
		 */
		reading?: string;
		/** Withhold the prompt text and its reading; see the component note. */
		hidePrompt?: boolean;
		/** Non-empty adds a speaker button after the prompt, reading this text. */
		speakText?: string;
		/** The profile's `targetLanguage`, for `speak()`. */
		speakLang?: string;
		/** Optional visible caption on the speaker button, e.g. "Play again". */
		speakLabel?: string;
		/**
		 * `lg` for a word or short phrase the learner reads once; `md` where the
		 * prompt is a whole native-language sentence, or a running count, and
		 * wants to sit closer to the content below it.
		 */
		size?: 'lg' | 'md';
	} = $props();

	const showRuby = $derived(promptTokens !== null && promptTokens.length > 0 && !hidePrompt);
	const showReading = $derived(reading !== '' && !hidePrompt && !showRuby);
	const hasPromptLine = $derived(prompt !== '' || hidePrompt || speakText !== '');
</script>

<p class="asked">{kicker}</p>

{#if hasPromptLine}
	<p class="prompt {size}" class:tight={showReading}>
		{#if hidePrompt}
			<span class="veiled" aria-hidden="true">· · ·</span>
		{:else if showRuby}
			<RubyText tokens={promptTokens ?? []} />
		{:else}
			<span>{prompt}</span>
		{/if}
		{#if speakText !== ''}
			<SpeakButton text={speakText} lang={speakLang} label={speakLabel} />
		{/if}
	</p>
{/if}

{#if showReading}
	<p class="rom prompt-rom">{reading}</p>
{/if}

<style>
	/*
	  The one display-font moment inside a challenge. Fraunces is the app's
	  heading voice and the prompt *is* the heading of the page the learner is
	  reading — but the stack falls straight through to `ui-serif` and the system
	  fonts, which is what renders a Chinese or Arabic prompt. Never let the
	  Latin webfont's metrics decide how those look.
	*/
	.prompt {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0 0 1.5rem;
		font-family: var(--font-display);
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		line-height: 1.2;
		letter-spacing: -0.012em;
		overflow-wrap: anywhere;
	}

	/* Lets a long prompt shrink instead of pushing the speaker button off. */
	.prompt > span {
		min-width: 0;
	}

	.prompt.lg {
		font-size: 1.9rem;
	}

	.prompt.md {
		font-size: 1.5rem;
	}

	/* A reading follows, and owns the trailing space instead. */
	.prompt.tight {
		margin-bottom: 0.2rem;
	}

	.prompt-rom {
		margin: 0 0 1.3rem;
		font-size: 1rem;
	}

	/* A placeholder with the prompt's own weight, so the reveal shifts nothing.
	   Three stitched dots — the same dashed hand as the rest of the paper. */
	.veiled {
		color: var(--border-strong);
		letter-spacing: 0.15em;
	}

	@media (max-width: 480px) {
		.prompt.lg {
			font-size: 1.5rem;
		}

		.prompt.md {
			font-size: 1.25rem;
		}
	}

	/*
	  A little more size once there is a real desk to read from. The column
	  itself stays at `--measure` — this buys legibility, never a longer line.
	*/
	@media (min-width: 72rem) {
		.prompt.lg {
			font-size: 2.15rem;
		}

		.prompt.md {
			font-size: 1.65rem;
		}
	}
</style>
