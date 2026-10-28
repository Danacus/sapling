<!--
  A file picker drawn as a dashed slot. The browser's own control says "No file
  chosen" where a verb belongs, so the input hides inside its label and the
  label is the affordance; dashed, because that is where this journal puts things.
-->
<script lang="ts">
	interface Props {
		label: string;
		accept: string;
		icon: 'upload' | 'video' | 'subtitles';
		disabled?: boolean;
		onchange: (event: Event) => void;
		/** The element, so a caller can empty it: no state assignment reaches a file input. */
		input?: HTMLInputElement | null;
	}

	let {
		label,
		accept,
		icon,
		disabled = false,
		onchange,
		input = $bindable(null)
	}: Props = $props();
</script>

<label class="file-btn">
	<input class="file-real" type="file" {accept} {disabled} bind:this={input} {onchange} />
	<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
		{#if icon === 'video'}
			<rect x="3.4" y="6.2" width="12.4" height="11.6" rx="2" />
			<path d="m15.8 12 4.8-3.2v6.4L15.8 12z" />
		{:else if icon === 'subtitles'}
			<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.2" />
			<path d="M7 12.4h4.2M13.4 12.4H17M7 15.4h7M16.2 15.4H17" />
		{:else}
			<path d="M12 16.4V4.9" />
			<path d="m7.6 9.3 4.4-4.4 4.4 4.4" />
			<path d="M4.6 15.1v2.8a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6v-2.8" />
		{/if}
	</svg>
	<span>{label}</span>
</label>

<style>
	.file-btn {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		padding: 0.65rem 0.85rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-alt) 55%, transparent);
		color: var(--text-muted);
		font-size: 0.85rem;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.file-btn span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* A label is never `:disabled` itself, only the label of something that is. */
	.file-btn:not(:has(:disabled)):hover {
		border-color: var(--text-muted);
		background: var(--surface-alt);
		color: var(--text);
	}

	.file-btn:has(:disabled) {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.file-btn:focus-within {
		border-color: var(--accent);
		box-shadow: var(--ring);
	}

	/* Hidden from the eye only: `display: none` would drop it from the tab order. */
	.file-real {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	.ico {
		width: 1.2rem;
		height: 1.2rem;
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
