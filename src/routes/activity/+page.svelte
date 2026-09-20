<script lang="ts">
	import { browser } from '$app/environment';
	import { getDailyActivity, localDay, streakFrom } from '$lib/db';
	import type { DailyActivity } from '$lib/db';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import {
		activityOf,
		longestStreak,
		monthCalendar,
		monthKey,
		shadeOf,
		shiftMonth
	} from './calendar';

	let loading = $state(true);
	let loadError = $state('');
	let activity = $state<DailyActivity[]>([]);
	const initialToday = localDay(Date.now());
	let today = $state(initialToday);
	let visibleMonth = $state(monthKey(initialToday));
	let selected = $state(initialToday);

	$effect(() => {
		if (!browser) return;
		let cancelled = false;
		loading = true;
		loadError = '';
		getDailyActivity()
			.then((days) => {
				if (cancelled) return;
				activity = days;
				today = localDay(Date.now());
				visibleMonth = monthKey(today);
				selected = today;
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your activity.';
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const byDay = $derived(new Map(activity.map((entry) => [entry.day, entry])));
	const cells = $derived(monthCalendar(visibleMonth));
	const monthEntries = $derived(activity.filter((entry) => monthKey(entry.day) === visibleMonth));
	const monthPeak = $derived(Math.max(0, ...monthEntries.map(activityOf)));
	const current = $derived(byDay.get(selected));
	const isCurrentMonth = $derived(visibleMonth === monthKey(today));
	const streak = $derived(streakFrom(activity.map((entry) => entry.day)));
	const longest = $derived(longestStreak(activity.map((entry) => entry.day)));
	const totalAnswers = $derived(activity.reduce((sum, entry) => sum + entry.count, 0));
	const monthTotals = $derived.by(() => ({
		active: monthEntries.length,
		answers: monthEntries.reduce((sum, entry) => sum + entry.count, 0),
		reviewed: monthEntries.reduce((sum, entry) => sum + entry.reviewed, 0),
		lookups: monthEntries.reduce((sum, entry) => sum + entry.lookups, 0),
		added: monthEntries.reduce((sum, entry) => sum + entry.added, 0),
		correct: monthEntries.reduce((sum, entry) => sum + entry.correct + entry.almost, 0)
	}));

	function dateOf(day: string): Date {
		const [year, month, date] = day.split('-').map(Number);
		return new Date(year, month - 1, date);
	}
	const monthTitle = $derived(
		new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
			dateOf(`${visibleMonth}-01`)
		)
	);
	const longDate = new Intl.DateTimeFormat(undefined, {
		weekday: 'long',
		day: 'numeric',
		month: 'long'
	});
	const weekdays = Array.from({ length: 7 }, (_, index) =>
		new Date(2024, 0, 1 + index).toLocaleDateString(undefined, { weekday: 'short' })
	);
	function titleOf(day: string): string {
		return day === today ? 'Today' : longDate.format(dateOf(day));
	}
	function describe(day: string): string {
		const entry = byDay.get(day);
		const label = longDate.format(dateOf(day));
		return entry
			? `${label}: ${entry.count} answers, ${entry.reviewed} words reviewed, ${entry.added} words added`
			: `${label}: no activity`;
	}
	function pct(part: number, whole: number): number {
		return whole === 0 ? 0 : Math.round((part / whole) * 100);
	}
	function openMonth(offset: number) {
		const next = shiftMonth(visibleMonth, offset);
		if (next > monthKey(today)) return;
		visibleMonth = next;
		selected = activity.filter((entry) => monthKey(entry.day) === next).at(-1)?.day ?? `${next}-01`;
	}
	function returnToToday() {
		visibleMonth = monthKey(today);
		selected = today;
	}
</script>

<svelte:head><title>Sapling · Activity</title></svelte:head>

<main class="shell shell-broad">
	<header class="page-head ll-rise">
		<BackLink href="/" label="Back to Today" />
		<div class="identity">
			<p class="eyebrow">Your growing rhythm</p>
			<h1>Activity</h1>
			<p>Look back at the days you showed up and the words you tended.</p>
		</div>
	</header>

	{#if loading}
		<div class="loading"><Spinner /></div>
	{:else if loadError}
		<section class="card"><p class="error" role="alert">{loadError}</p></section>
	{:else}
		<section class="streak-card ll-rise" style="animation-delay: 60ms">
			<div class="streak-lead">
				<div class="streak-mark" aria-hidden="true">
					<svg viewBox="0 0 48 48"
						><path
							d="M24 42V21m0 8c-7 0-12-4-13-11 7 0 12 4 13 11Zm0-7c6 0 10-3 12-9-6 0-10 3-12 9Z"
						/></svg
					>
				</div>
				<div>
					<span class="big-number">{streak}</span>
					<p><strong>day streak</strong><br />Keep the garden growing.</p>
				</div>
			</div>
			<div class="lifetime-stats">
				<div><strong>{longest}</strong><span>Longest streak</span></div>
				<div><strong>{activity.length}</strong><span>Active days</span></div>
				<div><strong>{totalAnswers.toLocaleString()}</strong><span>Answers</span></div>
			</div>
		</section>

		<section class="calendar-card card ll-rise" style="animation-delay: 120ms">
			<header class="calendar-head">
				<div>
					<p class="eyebrow">Month in view</p>
					<h2>{monthTitle}</h2>
				</div>
				<div class="month-nav">
					<button
						type="button"
						class="nav-button"
						onclick={() => openMonth(-1)}
						aria-label="Previous month">←</button
					>
					{#if !isCurrentMonth}<button type="button" class="today-button" onclick={returnToToday}
							>Today</button
						>{/if}
					<button
						type="button"
						class="nav-button"
						onclick={() => openMonth(1)}
						disabled={isCurrentMonth}
						aria-label="Next month">→</button
					>
				</div>
			</header>

			<div class="calendar-layout">
				<div class="calendar-wrap">
					<div class="weekday-row" aria-hidden="true">
						{#each weekdays as weekday}<span>{weekday}</span>{/each}
					</div>
					<div class="month-grid" role="grid" aria-label={monthTitle}>
						{#each cells as day, index (day ?? `empty-${index}`)}
							{#if day}
								{@const entry = byDay.get(day)}
								{@const future = day > today}
								<button
									type="button"
									class="day shade-{shadeOf(activityOf(entry), monthPeak)}"
									class:is-today={day === today}
									class:is-selected={day === selected}
									class:is-empty={!entry}
									disabled={future}
									aria-label={describe(day)}
									aria-pressed={day === selected}
									onclick={() => (selected = day)}
								>
									<span class="date-number">{Number(day.slice(-2))}</span>
									{#if entry}<span class="day-count">{activityOf(entry)}</span>{/if}
								</button>
							{:else}<span class="day-spacer"></span>{/if}
						{/each}
					</div>
					<div class="calendar-key" aria-hidden="true">
						<span>Quiet</span><i class="shade-1"></i><i class="shade-2"></i><i class="shade-3"
						></i><i class="shade-4"></i><span>Full</span>
					</div>
				</div>

				<aside class="day-detail" aria-live="polite">
					<p class="eyebrow">{selected === today ? 'Today' : 'Selected day'}</p>
					<h3>{titleOf(selected)}</h3>
					{#if !current}
						<div class="rest-day">
							<span aria-hidden="true">○</span>
							<p>A quiet day in the garden.</p>
						</div>
					{:else}
						{#if current.count > 0}
							<div class="answer-score">
								<strong>{current.count}</strong><span>answers</span><em
									>{pct(current.correct + current.almost, current.count)}% right</em
								>
							</div>
							<div
								class="verdicts"
								role="img"
								aria-label={`${current.correct} correct, ${current.almost} almost, ${current.wrong} wrong`}
							>
								{#if current.correct}<span class="correct" style:flex-grow={current.correct}
									></span>{/if}
								{#if current.almost}<span class="almost" style:flex-grow={current.almost}
									></span>{/if}
								{#if current.wrong}<span class="wrong" style:flex-grow={current.wrong}></span>{/if}
							</div>
						{/if}
						<dl class="day-facts">
							<div>
								<dt>Reviewed</dt>
								<dd>{current.reviewed}</dd>
							</div>
							<div>
								<dt>Looked up</dt>
								<dd>{current.lookups}</dd>
							</div>
							<div>
								<dt>Added</dt>
								<dd>{current.added}</dd>
							</div>
						</dl>
					{/if}
				</aside>
			</div>
		</section>

		<section class="month-summary ll-rise" style="animation-delay: 180ms">
			<div class="summary-copy">
				<p class="eyebrow">{monthTitle}</p>
				<h2>
					{monthTotals.active === 0
						? 'A fresh page'
						: `${monthTotals.active} active day${monthTotals.active === 1 ? '' : 's'}`}
				</h2>
				<p>
					{monthTotals.active === 0
						? 'There is no activity recorded in this month yet.'
						: `${monthTotals.answers} answers with ${pct(monthTotals.correct, monthTotals.answers)}% marked right or almost right.`}
				</p>
			</div>
			<div class="growth-grid">
				<div class="growth-stat">
					<span class="growth-icon">↻</span><strong>{monthTotals.reviewed}</strong><span
						>words reviewed</span
					>
				</div>
				<div class="growth-stat">
					<span class="growth-icon">⌕</span><strong>{monthTotals.lookups}</strong><span
						>words explored</span
					>
				</div>
				<div class="growth-stat">
					<span class="growth-icon">✦</span><strong>{monthTotals.added}</strong><span
						>words planted</span
					>
				</div>
			</div>
		</section>
	{/if}
</main>

<style>
	.shell {
		padding-block: 1.5rem 4rem;
		display: flex;
		flex-direction: column;
		gap: var(--gap);
	}
	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}
	.page-head {
		display: flex;
		align-items: flex-start;
		gap: 0.85rem;
	}
	.identity {
		min-width: 0;
	}
	.identity h1 {
		margin-bottom: 0.2rem;
		font-size: clamp(2rem, 5vw, 3rem);
	}
	.identity > p:last-child {
		margin: 0;
		max-width: 34rem;
		color: var(--text-muted);
	}
	.eyebrow {
		margin: 0 0 0.12rem;
		font-size: 0.7rem;
		font-weight: 800;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 70%, var(--text-muted));
	}
	.streak-card {
		display: grid;
		gap: 1rem;
		padding: 1rem;
		border: 1px solid var(--border);
		border-bottom: 3px solid var(--border-strong);
		border-radius: var(--radius-lg);
		background: linear-gradient(125deg, var(--primary-soft), var(--surface) 62%);
	}
	.streak-lead {
		display: flex;
		align-items: center;
		gap: 0.8rem;
	}
	.streak-mark {
		display: grid;
		place-items: center;
		width: 3.5rem;
		height: 3.5rem;
		border-radius: 50%;
		background: var(--primary);
		color: var(--text-inverse);
	}
	.streak-mark svg {
		width: 2.15rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.big-number {
		float: left;
		margin-right: 0.55rem;
		font-family: var(--font-display);
		font-size: 2.8rem;
		font-weight: 800;
		line-height: 1;
		color: var(--primary-strong);
	}
	.streak-lead p {
		margin: 0.15rem 0 0;
		color: var(--text-muted);
		line-height: 1.25;
	}
	.streak-lead strong {
		color: var(--text);
	}
	.lifetime-stats {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border-top: 1px solid color-mix(in srgb, var(--border-strong) 55%, transparent);
		padding-top: 0.8rem;
	}
	.lifetime-stats div {
		display: flex;
		flex-direction: column;
		padding-inline: 0.6rem;
		border-left: 1px solid var(--border);
	}
	.lifetime-stats div:first-child {
		padding-left: 0;
		border: 0;
	}
	.lifetime-stats strong {
		font-family: var(--font-display);
		font-size: 1.3rem;
		font-variant-numeric: tabular-nums;
	}
	.lifetime-stats span {
		font-size: 0.66rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--text-muted);
	}
	.calendar-card {
		max-width: none;
		padding: clamp(1rem, 3vw, 1.5rem);
	}
	.calendar-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1.25rem;
	}
	.calendar-head h2 {
		margin: 0;
		font-size: clamp(1.45rem, 4vw, 2rem);
	}
	.month-nav {
		display: flex;
		align-items: center;
		gap: 0.35rem;
	}
	.nav-button,
	.today-button {
		min-width: 2.6rem;
		height: 2.6rem;
		padding: 0 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
		color: var(--text);
		font: inherit;
		font-weight: 800;
		cursor: pointer;
	}
	.nav-button {
		font-size: 1.15rem;
	}
	.nav-button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.nav-button:focus-visible,
	.today-button:focus-visible,
	.day:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}
	.calendar-layout {
		display: grid;
		gap: 1.25rem;
	}
	.calendar-wrap {
		min-width: 0;
	}
	.weekday-row,
	.month-grid {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: 0.3rem;
	}
	.weekday-row {
		margin-bottom: 0.4rem;
	}
	.weekday-row span {
		text-align: center;
		font-size: 0.66rem;
		font-weight: 800;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.day,
	.day-spacer {
		min-width: 0;
		aspect-ratio: 1;
		border-radius: clamp(5px, 1vw, 10px);
	}
	.day {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		justify-content: space-between;
		padding: 0.32rem;
		border: 1px solid transparent;
		background: var(--surface-alt);
		color: var(--text);
		font: inherit;
		cursor: pointer;
		transition:
			transform 0.1s ease,
			box-shadow 0.15s ease;
	}
	.day:hover:not(:disabled) {
		transform: translateY(-2px);
	}
	.day:disabled {
		opacity: 0.28;
		cursor: default;
	}
	.day.shade-1 {
		background: color-mix(in srgb, var(--primary) 24%, var(--surface-alt));
	}
	.day.shade-2 {
		background: color-mix(in srgb, var(--primary) 43%, var(--surface-alt));
	}
	.day.shade-3 {
		background: color-mix(in srgb, var(--primary) 65%, var(--surface));
	}
	.day.shade-4 {
		background: var(--primary);
		color: var(--text-inverse);
	}
	.day.is-empty {
		background: transparent;
		border-color: color-mix(in srgb, var(--border) 75%, transparent);
	}
	.day.is-today {
		border-color: var(--accent);
	}
	.day.is-selected {
		box-shadow: 0 0 0 3px var(--accent);
		z-index: 1;
	}
	.date-number {
		font-size: 0.78rem;
		font-weight: 800;
		line-height: 1;
	}
	.day-count {
		align-self: flex-end;
		font-size: 0.65rem;
		font-weight: 800;
		opacity: 0.8;
	}
	.calendar-key {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.3rem;
		margin-top: 0.7rem;
		font-size: 0.68rem;
		font-weight: 700;
		color: var(--text-muted);
	}
	.calendar-key i {
		width: 0.8rem;
		height: 0.8rem;
		border-radius: 3px;
		background: var(--surface-alt);
	}
	.calendar-key .shade-1 {
		background: color-mix(in srgb, var(--primary) 24%, var(--surface-alt));
	}
	.calendar-key .shade-2 {
		background: color-mix(in srgb, var(--primary) 43%, var(--surface-alt));
	}
	.calendar-key .shade-3 {
		background: color-mix(in srgb, var(--primary) 65%, var(--surface));
	}
	.calendar-key .shade-4 {
		background: var(--primary);
	}
	.day-detail {
		padding: 1rem;
		border-radius: var(--radius);
		background: var(--surface-alt);
	}
	.day-detail h3 {
		margin-bottom: 1rem;
		font-size: 1.25rem;
	}
	.rest-day {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		color: var(--text-muted);
	}
	.rest-day > span {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border: 1px dashed var(--border-strong);
		border-radius: 50%;
	}
	.rest-day p {
		margin: 0;
	}
	.answer-score {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
	}
	.answer-score strong {
		font-family: var(--font-display);
		font-size: 2.1rem;
		line-height: 1;
	}
	.answer-score span {
		color: var(--text-muted);
	}
	.answer-score em {
		margin-left: auto;
		font-size: 0.78rem;
		font-style: normal;
		font-weight: 800;
		color: var(--primary-strong);
	}
	.verdicts {
		display: flex;
		gap: 2px;
		height: 0.45rem;
		margin: 0.55rem 0 1rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--border);
	}
	.verdicts span {
		flex-basis: 0;
		min-width: 3px;
	}
	.correct {
		background: var(--primary);
	}
	.almost {
		background: var(--amber);
	}
	.wrong {
		background: var(--danger);
	}
	.day-facts {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.4rem;
		margin: 0;
	}
	.day-facts div {
		padding: 0.55rem;
		border-radius: var(--radius-sm);
		background: var(--surface);
		text-align: center;
	}
	.day-facts dt {
		font-size: 0.62rem;
		font-weight: 800;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.day-facts dd {
		margin: 0.05rem 0 0;
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 800;
	}
	.month-summary {
		display: grid;
		gap: 1rem;
		padding: clamp(1rem, 3vw, 1.5rem);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
	}
	.summary-copy h2 {
		margin-bottom: 0.25rem;
	}
	.summary-copy > p:last-child {
		margin: 0;
		max-width: 30rem;
		color: var(--text-muted);
	}
	.growth-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.5rem;
	}
	.growth-stat {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto auto;
		align-items: center;
		gap: 0 0.5rem;
		padding: 0.75rem;
		border-radius: var(--radius);
		background: var(--surface-alt);
	}
	.growth-icon {
		grid-row: 1 / 3;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: var(--primary-soft);
		color: var(--primary-strong);
		font-weight: 900;
	}
	.growth-stat strong {
		font-family: var(--font-display);
		font-size: 1.35rem;
		line-height: 1;
	}
	.growth-stat > span:last-child {
		font-size: 0.68rem;
		font-weight: 800;
		color: var(--text-muted);
	}
	.error {
		margin: 0;
		color: var(--danger);
		font-weight: 700;
	}
	@media (min-width: 48rem) {
		.streak-card {
			grid-template-columns: minmax(15rem, 1fr) minmax(20rem, 1.3fr);
			align-items: center;
			padding: 1.25rem 1.5rem;
		}
		.lifetime-stats {
			border-top: 0;
			padding-top: 0;
		}
		.calendar-layout {
			grid-template-columns: minmax(0, 2.2fr) minmax(14rem, 1fr);
			align-items: stretch;
		}
		.day-detail {
			padding: 1.25rem;
		}
		.month-summary {
			grid-template-columns: minmax(14rem, 1fr) minmax(24rem, 1.4fr);
			align-items: center;
		}
		.day {
			padding: 0.45rem;
		}
		.date-number {
			font-size: 0.9rem;
		}
	}
	@media (max-width: 30rem) {
		.identity > p:last-child {
			display: none;
		}
		.lifetime-stats span {
			font-size: 0.57rem;
			letter-spacing: 0.04em;
		}
		.calendar-head {
			align-items: flex-end;
		}
		.today-button {
			display: none;
		}
		.weekday-row,
		.month-grid {
			gap: 0.2rem;
		}
		.growth-grid {
			grid-template-columns: 1fr;
		}
		.growth-stat {
			grid-template-columns: auto auto 1fr;
			grid-template-rows: 1fr;
		}
		.growth-icon {
			grid-row: auto;
		}
	}
</style>
