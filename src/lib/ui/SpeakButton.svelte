<!--
  A speaker button that reads target-language text aloud.

  Placed next to whatever text *is* the thing being learned — a prompt, a
  sentence, a word in a list. Deliberately never hidden when speech is
  unavailable: it renders disabled instead, so the affordance is discoverable
  and Settings is where you go to turn it on.

  It also never lets audio hold up a lesson. `speak()` swallows its own
  failures, and the busy state is cleared in a `finally`, so a model that
  refuses to load leaves a button that simply stops spinning.
-->
<script lang="ts">
	import { speak, ttsAvailable } from '$lib/tts';

	let {
		text,
		lang = '',
		label = '',
		size = 'md'
	}: {
		/** The target-language string to say. Blank disables the button. */
		text: string;
		/** The profile's free-text `targetLanguage`, e.g. "Spanish". */
		lang?: string;
		/** Optional visible caption next to the icon, e.g. "Hear it". */
		label?: string;
		size?: 'sm' | 'md';
	} = $props();

	let busy = $state(false);

	const phrase = $derived(text?.trim() ?? '');
	// `ttsAvailable` reads the engine pref; re-evaluated whenever the text or
	// language changes, which is often enough for a setting that lives on
	// another page.
	const disabled = $derived(phrase.length === 0 || !ttsAvailable(lang));

	async function play(): Promise<void> {
		if (disabled || busy) return;
		busy = true;
		try {
			await speak(phrase, lang);
		} finally {
			busy = false;
		}
	}
</script>

<button
	type="button"
	class="speak {size}"
	class:busy
	class:has-label={label !== ''}
	{disabled}
	aria-busy={busy}
	aria-label={label || (phrase ? `Listen to ${phrase}` : 'Listen')}
	title={disabled ? 'Speech is off — turn it on in Settings' : 'Listen'}
	onclick={() => void play()}
>
	<span class="icon" aria-hidden="true">🔊</span>
	{#if label}<span class="label">{label}</span>{/if}
</button>

<style>
	.speak {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		vertical-align: middle;
		transition:
			background 0.15s ease,
			opacity 0.15s ease;
	}

	.speak.sm {
		font-size: 0.85rem;
		padding: 0.25rem;
	}

	/* After `.sm` on purpose: a labelled button needs its horizontal padding
	   back even at the small size. */
	.speak.has-label {
		padding: 0.35rem 0.7rem 0.35rem 0.55rem;
		font-size: 0.82rem;
		font-weight: 800;
	}

	.speak:hover:not(:disabled) {
		background: var(--surface-alt);
	}

	.speak:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.speak:disabled {
		cursor: default;
		opacity: 0.35;
	}

	.icon {
		display: inline-block;
	}

	/* Synthesizing (or downloading the model) — a pulse rather than a spinner,
	   because the icon has no meaningful rotation. */
	.speak.busy .icon {
		animation: ll-speak-pulse 0.9s ease-in-out infinite;
	}

	.speak.busy {
		cursor: progress;
	}

	@keyframes ll-speak-pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.45;
			transform: scale(0.85);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.speak.busy .icon {
			animation-duration: 2.4s;
		}
	}
</style>
