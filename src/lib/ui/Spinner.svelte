<!--
  Small centered loading spinner. Mirrors the boot spinner in
  `src/routes/+layout.svelte` so the loading feel is consistent across the
  app; kept here as a shared component since dashboard and settings both
  show a spinner while their data loads.
-->
<div class="spinner" role="status" aria-label="Loading"></div>

<style>
	/* Two hairline arcs turning against each other — a compass needle rather
	   than a loading donut. Thin strokes suit the paper; the counter-rotation
	   is what makes it read as crafted instead of stock. */
	.spinner {
		position: relative;
		width: 2.25rem;
		height: 2.25rem;
		margin: 0 auto;
		border: 2px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 0.9s cubic-bezier(0.55, 0.15, 0.4, 0.85) infinite;
	}

	.spinner::after {
		content: '';
		position: absolute;
		inset: 0.3rem;
		border: 2px solid transparent;
		border-bottom-color: var(--accent);
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
