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
	.bar {
		width: 100%;
		height: 0.6rem;
		border-radius: 999px;
		background: var(--surface-alt);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		border-radius: 999px;
		transition:
			width 0.3s ease,
			background 0.3s ease;
	}
</style>
