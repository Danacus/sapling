<!--
  Generic horizontal progress bar. `value` is a 0..1 fraction (clamped);
  `color` is any CSS color value, so callers can drive it from a design
  token (`var(--primary)`) or a computed color (strength bars).

  Used by the dashboard for the daily-goal ring and the per-word strength
  bars, so it lives here instead of being duplicated.
-->
<script lang="ts">
	let {
		value,
		color = 'var(--primary)',
		label
	}: { value: number; color?: string; label?: string } = $props();

	const pct = $derived(Math.round(Math.max(0, Math.min(1, value)) * 100));
</script>

<div
	class="bar"
	role="progressbar"
	aria-valuenow={pct}
	aria-valuemin={0}
	aria-valuemax={100}
	aria-label={label}
>
	<div class="fill" style={`width: ${pct}%; background: ${color};`}></div>
</div>

<style>
	/* A ruled measure rather than a capsule: hairline trough, squared ends, a
	   hint of inset so the fill reads as ink laid into the paper. */
	.bar {
		width: 100%;
		height: 0.55rem;
		border: 1px solid var(--border);
		border-radius: 3px;
		background: var(--surface-alt);
		box-shadow: inset 0 1px 2px rgb(60 50 20 / 8%);
		overflow: hidden;
	}

	.fill {
		position: relative;
		height: 100%;
		border-radius: 2px;
		transition:
			width 0.35s cubic-bezier(0.2, 0.7, 0.3, 1),
			background 0.3s ease;
	}

	/* A faint top highlight keeps the fill from reading as flat plastic. It has
	   to be a pseudo-element: `color` arrives as an inline `background`
	   shorthand, which would blow away any `background-image` set here. */
	.fill::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: linear-gradient(rgb(255 255 255 / 24%), rgb(255 255 255 / 0%) 65%);
	}

	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}
	}
</style>
