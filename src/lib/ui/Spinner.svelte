<!--
  Small centered loading spinner. Mirrors the boot spinner in
  `src/routes/+layout.svelte` so the loading feel is consistent across the
  app; kept here as a shared component since dashboard and settings both
  show a spinner while their data loads.
-->
<div class="spinner" role="status" aria-label="Loading"></div>

<style>
	.spinner {
		width: 2.5rem;
		height: 2.5rem;
		margin: 0 auto;
		border: 4px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
</style>
