<!--
  The one place to watch every background job from — a lesson being written,
  a text being annotated, the voice model downloading — wherever the learner
  happens to be.

  Renders nothing until there is a task to show. Then a small pill sits at
  the foot of the viewport, right-hand side, saying how many jobs are going
  (or, once they have all settled, whether they went well), and tapping it
  opens the list: on a phone a sheet at the foot of the screen, at ≥48rem a
  card floating in the same corner, bounded so a long title wraps rather than
  stretching a line across a desk.

  Every fact here is read from `taskStore`; the tray holds nothing but
  whether it is open. Cancel, Retry and Dismiss call the runner directly.
-->
<script lang="ts">
	import { fly } from 'svelte/transition';

	import { motionMs } from '$lib/session/motion';
	import { cancelTask, dismissTask, retryTask } from '$lib/tasks';
	import type { Task } from '$lib/tasks';
	import { taskStore } from '$lib/tasks/store.svelte';

	import ProgressBar from './ProgressBar.svelte';
	import TaskLedger from './TaskLedger.svelte';

	let open = $state(false);

	const tasks = $derived(taskStore.tasks);
	const running = $derived(taskStore.running);
	const failed = $derived(tasks.filter((task) => task.status === 'failed'));
	const settled = $derived(
		tasks.filter((task) => task.status !== 'queued' && task.status !== 'running')
	);

	/** Dismisses every finished task at once; the tray goes with them when nothing is left. */
	function clearSettled() {
		for (const task of settled) dismissTask(task.id);
		if (settled.length === tasks.length) open = false;
	}

	/** Newest first: the job the learner just started is the one they came to see. */
	const listed = $derived(tasks.slice().reverse());

	function statusLabel(task: Task): string {
		switch (task.status) {
			case 'queued':
				return 'Waiting';
			case 'running':
				return 'Running';
			case 'done':
				return 'Done';
			case 'failed':
				return 'Failed';
			case 'cancelled':
				return 'Cancelled';
		}
	}

	function totalMs(task: Task): number | null {
		if (task.status !== 'done' || task.startedAt === undefined || task.finishedAt === undefined) {
			return null;
		}
		return task.finishedAt - task.startedAt;
	}

	function fraction(task: Task): number {
		const progress = task.progress;
		if (!progress || progress.total <= 0) return 0;
		return progress.done / progress.total;
	}

	function progressLine(task: Task): string {
		const progress = task.progress;
		if (!progress) return '';
		const unit = progress.unit ? ` ${progress.unit}` : '';
		return `${progress.done} / ${progress.total}${unit}`;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) {
			open = false;
			event.stopPropagation();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if tasks.length > 0 && !taskStore.hidden}
	<div class="tray">
		{#if open}
			<section
				class="panel"
				aria-label="Background tasks"
				transition:fly={{ y: 16, duration: motionMs(200) }}
			>
				<header class="panel-head">
					<h2>Background tasks</h2>
					{#if settled.length > 0}
						<button type="button" class="btn btn-ghost small clear" onclick={clearSettled}>
							Clear
						</button>
					{/if}
					<button type="button" class="close" aria-label="Close" onclick={() => (open = false)}>
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
							><path d="M6 6l12 12M18 6 6 18" /></svg
						>
					</button>
				</header>
				<ul class="list">
					{#each listed as task (task.id)}
						{@const busy = task.status === 'queued' || task.status === 'running'}
						<li class="task" class:failed={task.status === 'failed'}>
							<div class="task-head">
								<span class="title">{task.title}</span>
								<span class="status status-{task.status}">{statusLabel(task)}</span>
							</div>

							{#if task.progress && (busy || task.steps.length === 0)}
								<div class="progress">
									<ProgressBar value={fraction(task)} label={`${task.title} progress`} />
									<span class="progress-line">{progressLine(task)}</span>
								</div>
							{/if}
							{#if task.steps.length > 0}
								<TaskLedger steps={task.steps} totalMs={totalMs(task)} />
							{/if}

							{#if task.status === 'done' && task.summary}
								<p class="summary">{task.summary}</p>
							{:else if task.status === 'failed' && task.error}
								<p class="error" role="alert">{task.error}</p>
							{:else if task.status === 'queued'}
								<p class="summary">Waiting for the one before it.</p>
							{/if}

							<div class="actions">
								{#if busy}
									<button
										type="button"
										class="btn btn-ghost small"
										onclick={() => cancelTask(task.id)}
									>
										{task.cancellable ? 'Cancel' : 'Stop watching'}
									</button>
								{:else}
									{#if task.status !== 'done' && task.retryable}
										<button
											type="button"
											class="btn btn-ghost small"
											onclick={() => void retryTask(task.id)}
										>
											Retry
										</button>
									{/if}
									<button
										type="button"
										class="btn btn-ghost small"
										onclick={() => dismissTask(task.id)}
									>
										Dismiss
									</button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<button
			type="button"
			class="pill"
			class:busy={running.length > 0}
			class:trouble={running.length === 0 && failed.length > 0}
			aria-expanded={open}
			aria-label={running.length > 0
				? `${running.length} background task${running.length === 1 ? '' : 's'} running`
				: 'Background tasks'}
			onclick={() => (open = !open)}
		>
			{#if running.length > 0}
				<span class="pill-spinner" aria-hidden="true"></span>
				<span class="pill-text">{running.length} running</span>
			{:else if failed.length > 0}
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
					><path d="M12 6.5v7" /><path d="M12 17.2h.01" /></svg
				>
				<span class="pill-text">{failed.length} failed</span>
			{:else}
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"
					><path d="m5 12.8 4.4 4.4L19 7.6" /></svg
				>
				<span class="pill-text">Done</span>
			{/if}
		</button>
	</div>
{/if}

<style>
	/*
	  Above the route sheets (the feedback banner and the reader's word card
	  both sit at 20) and below a modal overlay (30): a job's pill must survive
	  a sheet opening, and a confirmation must cover the pill.
	*/
	.tray {
		position: fixed;
		right: var(--gutter);
		bottom: calc(var(--gutter) + env(safe-area-inset-bottom, 0px));
		z-index: 25;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.6rem;
		max-width: calc(100vw - 2 * var(--gutter));
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.9rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 0.84rem;
		font-weight: 600;
		box-shadow: var(--shadow);
		cursor: pointer;
	}

	.pill:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.pill.busy {
		color: var(--primary-strong);
	}

	.pill.trouble {
		color: var(--danger);
	}

	/* Line icons: no fill, or an open path such as the close cross draws nothing. */
	.ico {
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.pill .ico {
		width: 1rem;
		height: 1rem;
		stroke-width: 2;
	}

	.pill-spinner {
		width: 0.8rem;
		height: 0.8rem;
		border: 2px solid var(--border);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: ll-pill-spin 0.8s linear infinite;
	}

	@keyframes ll-pill-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pill-spinner {
			animation-duration: 2.4s;
		}
	}

	/*
	  The base case is a phone: the panel is a sheet at the foot of the screen,
	  full width, scrolling inside itself so a long list never pushes the pill
	  off screen. The wide rule below turns it into a floating card.
	*/
	.panel {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 25;
		max-height: min(70dvh, 32rem);
		display: flex;
		flex-direction: column;
		border-top: 1px solid var(--border-strong);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		background: var(--surface);
		box-shadow: var(--shadow);
		padding-bottom: env(safe-area-inset-bottom, 0px);
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.8rem var(--gutter) 0.5rem;
	}

	.panel-head h2 {
		/* Pushes Clear and the close cross to the far end of the row. */
		margin: 0 auto 0 0;
		font-size: 0.95rem;
	}

	.close {
		display: inline-flex;
		padding: 0.3rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close .ico {
		width: 1.1rem;
		height: 1.1rem;
		stroke-width: 1.9;
	}

	.close:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.list {
		margin: 0;
		padding: 0 var(--gutter) 0.8rem;
		list-style: none;
		overflow-y: auto;
		min-height: 0;
	}

	.task {
		padding: 0.7rem 0;
	}

	.task + .task {
		border-top: 1px solid var(--border);
	}

	.task-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.title {
		min-width: 0;
		overflow-wrap: anywhere;
		font-weight: 600;
	}

	.status {
		flex: 0 0 auto;
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	.status-running {
		color: var(--primary-strong);
	}

	.status-failed {
		color: var(--danger);
	}

	.progress {
		display: grid;
		gap: 0.3rem;
		margin-top: 0.5rem;
	}

	.progress-line {
		font-size: 0.78rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.summary {
		margin: 0.45rem 0 0;
		font-size: 0.84rem;
		color: var(--text-muted);
	}

	/* The app's one error treatment. */
	.error {
		margin: 0.45rem 0 0;
		padding: 0.5rem 0.7rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.84rem;
	}

	.actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.small {
		padding: 0.3rem 0.7rem;
		font-size: 0.8rem;
	}

	/* Wide: a card in the corner instead of a sheet. */
	@media (min-width: 48rem) {
		.panel {
			position: static;
			width: 24rem;
			max-width: calc(100vw - 2 * var(--gutter));
			border: 1px solid var(--border-strong);
			border-radius: var(--radius-lg);
			padding-bottom: 0;
		}
	}
</style>
