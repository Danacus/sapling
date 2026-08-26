<!--
  Small centered loading spinner — the app's only one. The boot shell in
  `src/routes/+layout.svelte` renders it too, so the very first thing the app
  draws and every later loading state are the same object, not two that have
  to be kept looking alike.
-->
<div class="spinner" role="status" aria-label="Loading"></div>

<style>
	/* Two hairline arcs turning against each other — a compass needle rather
	   than a loading donut. Thin strokes suit the paper; the counter-rotation
	   is what makes it read as crafted instead of stock.

	   Both arcs are the same hue, `--spinner-tone` (green by default), just at
	   two strengths — the inner ring is the tone mixed toward transparent, so
	   it reads as the outer ring's shadow rather than a second, clashing
	   color. A caller can override the tone (e.g. to match a verdict banner)
	   by setting `--spinner-tone` on an ancestor, since custom properties
	   inherit. */
	.spinner {
		--spinner-tone: var(--primary);
		position: relative;
		width: 2.25rem;
		height: 2.25rem;
		margin: 0 auto;
		border: 2px solid var(--border);
		border-top-color: var(--spinner-tone);
		border-radius: 50%;
		animation: spin 0.9s cubic-bezier(0.55, 0.15, 0.4, 0.85) infinite;
	}

	.spinner::after {
		content: '';
		position: absolute;
		inset: 0.3rem;
		border: 2px solid transparent;
		border-bottom-color: color-mix(in srgb, var(--spinner-tone) 45%, transparent);
		border-radius: 50%;
		animation: spin 1.4s linear infinite reverse;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner,
		.spinner::after {
			animation-duration: 2.4s;
			animation-timing-function: linear;
		}
	}
</style>
