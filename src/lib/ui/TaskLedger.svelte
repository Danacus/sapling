<!--
  A ruled ledger of what a task is doing and where the seconds went — the
  step log the session screen grew for lesson generation, now shared with the
  task tray.

  Each step shows its own duration, the open one ticking, so "that felt long"
  can be checked against a number — above all whether the time went into the
  model call. The ticker runs only while a step is open, and only here: the
  runner stamps `startedAt`/`endedAt` and never counts.
-->
<script lang="ts">
	import { fade } from 'svelte/transition';

	import { motionMs } from '$lib/session/motion';
	import type { TaskStep } from '$lib/tasks';

	let {
		steps,
		totalMs = null,
		doneMessage
	}: {
		steps: TaskStep[];
		/**
		 * The whole run's duration once it has finished; `null` while it runs or
		 * after it failed. Shown under the ledger with `doneMessage`.
		 */
		totalMs?: number | null;
		/** Follows the total, e.g. "it's in the pool". Optional. */
		doneMessage?: string;
	} = $props();

	const running = $derived(steps.some((step) => step.endedAt === undefined));

	/** Ticks while a step is open, so its counter moves. */
	let now = $state(Date.now());

	$effect(() => {
		if (!running) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 100);
		return () => clearInterval(timer);
	});

	function seconds(step: TaskStep): string {
		return (((step.endedAt ?? now) - step.startedAt) / 1000).toFixed(1);
	}
</script>

{#if steps.length > 0}
	<ul class="steps" role="status" aria-live="polite">
		{#each steps as step, index (index)}
			{@const done = step.endedAt !== undefined}
			<li class:done>
				{#if done}
					<span class="mark" aria-hidden="true">
						<svg class="ico" viewBox="0 0 24 24"><path d="m5 12.8 4.4 4.4L19 7.6" /></svg>
					</span>
				{:else}
					<span class="mark spinner" aria-hidden="true"></span>
				{/if}
				<span class="label">{step.label}</span>
				<span class="secs">{seconds(step)}s</span>
			</li>
		{/each}
	</ul>
	{#if totalMs !== null}
		<p class="total" transition:fade={{ duration: motionMs(200) }}>
			Done in {(totalMs / 1000).toFixed(1)}s{doneMessage ? ` — ${doneMessage}` : ''}
		</p>
	{/if}
{/if}

<style>
	/* Hairline between entries, the same rule the word lists use. */
	.steps {
		display: flex;
		flex-direction: column;
		width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.84rem;
		color: var(--text-muted);
	}

	.steps li {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		padding: 0.35rem 0;
	}

	.steps li + li {
		border-top: 1px solid var(--border);
	}

	.steps li.done {
		opacity: 0.65;
	}

	.mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 1rem;
	}

	.mark .ico {
		width: 0.95rem;
		height: 0.95rem;
		stroke-width: 1.9;
	}

	.spinner {
		width: 0.75rem;
		height: 0.75rem;
		border: 2px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: ll-step-spin 0.8s linear infinite;
	}

	@keyframes ll-step-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}

	.steps li.done .mark {
		color: var(--primary);
	}

	.label {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.steps li:not(.done) .label {
		color: var(--text);
		font-weight: 700;
	}

	.secs {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
	}

	.total {
		margin: 0.6rem 0 0;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-muted);
	}
</style>
