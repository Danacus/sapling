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
	<span class="status saved" role="status">✓ {message ?? 'Saved'}</span>
{:else if status === 'error'}
	<span class="status error" role="alert">{message ?? 'Something went wrong.'}</span>
{/if}

<style>
	.status {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.85rem;
		font-weight: 700;
	}

	.status.saved {
		color: var(--primary-strong);
	}

	.status.error {
		color: var(--danger);
	}
</style>
