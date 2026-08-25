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
	<span class="icon" aria-hidden="true">
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.6"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			<path d="M11.5 4.6 6.8 8.4H4.2a.7.7 0 0 0-.7.7v5.8c0 .4.3.7.7.7h2.6l4.7 3.8a.6.6 0 0 0 1-.5V5.1a.6.6 0 0 0-1-.5Z" />
			<path class="wave wave-1" d="M15.6 9.4a3.5 3.5 0 0 1 0 5.2" />
			<path class="wave wave-2" d="M18.4 6.9a7 7 0 0 1 0 10.2" />
		</svg>
	</span>
	{#if label}<span class="label">{label}</span>{/if}
</button>

<style>
	.speak {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 0.35rem;
		padding: 0.3rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		vertical-align: middle;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease,
			opacity 0.15s ease;
	}

	.speak.sm {
		font-size: 0.85rem;
		padding: 0.2rem;
	}

	/* After `.sm` on purpose: a labelled button needs its horizontal padding
	   back even at the small size. */
	.speak.has-label {
		padding: 0.35rem 0.7rem 0.35rem 0.55rem;
		font-size: 0.82rem;
		font-weight: 700;
	}

	.speak:hover:not(:disabled) {
		background: var(--surface-alt);
		border-color: var(--border);
		color: var(--accent);
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
		display: inline-flex;
	}

	/* Sized in `em` so the `sm`/`md`/labelled font sizes above keep driving the
	   icon exactly as they did when this was a glyph. */
	.icon svg {
		display: block;
		width: 1.35em;
		height: 1.35em;
	}

	/* Synthesizing (or downloading the model) — the two arcs breathe outwards
	   in turn, which says "sound is coming" far better than a spinner on an
	   icon with no meaningful rotation. */
	.speak.busy {
		cursor: progress;
		color: var(--accent);
	}

	.speak.busy .wave {
		animation: ll-speak-wave 1.1s ease-in-out infinite;
	}

	.speak.busy .wave-2 {
		animation-delay: 0.18s;
	}

	@keyframes ll-speak-wave {
		0%,
		100% {
			opacity: 0.25;
		}
		45% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.speak.busy .wave {
			animation-duration: 2.6s;
		}
	}
</style>
