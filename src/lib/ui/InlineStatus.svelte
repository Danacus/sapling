<!--
  Inline "saved ✓" / error feedback for a single form action. The settings
  page has several independent save actions (profile goal, API key, model,
  export, import, reset) that all need the same transient feedback, so the
  rendering lives here once; callers own the timing (flip back to 'idle'
  after a delay).
-->
<script lang="ts">
	let { status, message }: { status: 'idle' | 'saved' | 'error'; message?: string } = $props();
</script>

{#if status === 'saved'}
	<span class="status saved" role="status">
		<svg
			class="mark"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.9"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="m5 12.8 4.4 4.4L19 7.6" />
		</svg>
		{message ?? 'Saved'}
	</span>
{:else if status === 'error'}
	<span class="status error" role="alert">
		<svg
			class="mark"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.9"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M12 6.5v7" />
			<path d="M12 17.4h.01" />
		</svg>
		{message ?? 'Something went wrong.'}
	</span>
{/if}

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.85rem;
		font-weight: 700;
		line-height: 1.35;
	}

	/* The tick is drawn, not typed — the ✓ glyph rendered at a different weight
	   in every fallback font the app can land on. */
	.mark {
		flex: 0 0 auto;
		width: 1.05em;
		height: 1.05em;
	}

	.status.saved {
		color: var(--primary-strong);
	}

	.status.error {
		color: var(--danger);
	}
</style>
