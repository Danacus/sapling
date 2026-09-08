<!--
  Every day, on one page: the last half-year as a calendar of shaded cells,
  one day opened beside it, and the days themselves as a ledger underneath.

  The home screen's strip is a shape to glance at; this is where the shape is
  read. Everything on it comes from one `getDailyActivity` read — the core
  folds answers, reviews, lookups and added words into a row per day — and the
  page only arranges: `calendar.ts` cuts the weeks, the rest is markup.

  A day is the unit throughout. Tapping a cell or a ledger row opens that day
  in the card beside the calendar, which is the spread's usual pairing: the
  overview opposite the one thing being looked at. Nothing is stored — the
  selected day is page state and the page opens on today.
-->
<script lang="ts">
	import { browser } from '$app/environment';

	import { getDailyActivity, localDay, streakFrom } from '$lib/db';
	import type { DailyActivity } from '$lib/db';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	import { activityOf, calendarWeeks, longestStreak, monthStarts, shadeOf } from './calendar';

	/** Half a year of columns: what fits a card at the wide breakpoint without shrinking the cells. */
	const WEEKS = 26;
	/** Ledger rows shown before the rest is asked for. */
	const LEDGER_PAGE = 42;

	let loading = $state(true);
	let loadError = $state('');
	let activity = $state<DailyActivity[]>([]);
	let today = $state(localDay(Date.now()));
	let selected = $state('');
	let showAll = $state(false);
	let scroller = $state<HTMLDivElement | null>(null);

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

	// The newest column is the rightmost, so on a phone the strip opens scrolled
	// to the present rather than to six months ago.
	$effect(() => {
		if (scroller) scroller.scrollLeft = scroller.scrollWidth;
	});

	const byDay = $derived(new Map(activity.map((entry) => [entry.day, entry])));
	const weeks = $derived(calendarWeeks(today, WEEKS));
	const peak = $derived(Math.max(0, ...weeks.flat().map((day) => activityOf(byDay.get(day)))));

	const streak = $derived(streakFrom(activity.map((entry) => entry.day)));
	const longest = $derived(longestStreak(activity.map((entry) => entry.day)));
	const answers = $derived(activity.reduce((sum, entry) => sum + entry.count, 0));

	/** The ledger: every day something happened, newest first. */
	const ledger = $derived([...activity].reverse());
	const shown = $derived(showAll ? ledger : ledger.slice(0, LEDGER_PAGE));

	const current = $derived(byDay.get(selected));

	/* Dates ------------------------------------------------------------------ */

	function dateOf(day: string): Date {
		const [year, month, date] = day.split('-').map(Number);
		return new Date(year, month - 1, date);
	}

	const longDate = new Intl.DateTimeFormat(undefined, {
		weekday: 'long',
		day: 'numeric',
		month: 'long'
	});
	const shortDate = new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short'
	});
	const monthName = new Intl.DateTimeFormat(undefined, { month: 'short' });

	const months = $derived(monthStarts(weeks, (day) => monthName.format(dateOf(day))));

	/** Single-letter weekday labels down the side, in the reader's own locale: Mon, Wed, Fri. */
	const weekdayLetters = $derived(
		[0, 2, 4].map((row) => ({
			row,
			letter: dateOf(weeks[0][row]).toLocaleDateString(undefined, { weekday: 'narrow' })
		}))
	);

	function titleOf(day: string): string {
		if (day === today) return 'Today';
		return longDate.format(dateOf(day));
	}

	/** What a cell says to a screen reader and on hover. */
	function describe(day: string): string {
		const entry = byDay.get(day);
		const date = shortDate.format(dateOf(day));
		if (!entry) return `${date}: nothing`;
		const parts = [
			entry.count > 0 ? `${entry.count} answer${entry.count === 1 ? '' : 's'}` : '',
			entry.reviewed > 0 ? `${entry.reviewed} word${entry.reviewed === 1 ? '' : 's'} reviewed` : '',
			entry.lookups > 0 ? `${entry.lookups} looked up` : '',
			entry.added > 0 ? `${entry.added} added` : ''
		].filter(Boolean);
		return `${date}: ${parts.join(', ')}`;
	}

	function pct(part: number, whole: number): number {
		return whole === 0 ? 0 : Math.round((part / whole) * 100);
	}
</script>

<svelte:head>
	<title>Sapling · Activity</title>
</svelte:head>

<main class="shell shell-broad">
	<header class="topbar ll-rise">
		<BackLink href="/" label="Back to home" />
		<div class="identity">
			<p class="eyebrow">Sapling</p>
			<h1>Activity</h1>
		</div>
	</header>

	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<section class="card">
			<p class="error" role="alert">{loadError}</p>
		</section>
	{:else}
		<div class="summary ll-rise" style="animation-delay: 60ms">
			<div class="tile">
				<span class="tile-num" class:accented={streak > 0}>{streak}</span>
				<span class="tile-label">Day streak</span>
			</div>
			<div class="tile">
				<span class="tile-num">{longest}</span>
				<span class="tile-label">Longest</span>
			</div>
			<div class="tile">
				<span class="tile-num">{activity.length}</span>
				<span class="tile-label">Active days</span>
			</div>
			<div class="tile">
				<span class="tile-num">{answers.toLocaleString()}</span>
				<span class="tile-label">Answers</span>
			</div>
		</div>

		<!-- The calendar. Weeks are columns, days run down them Monday to Sunday,
		     and the shade is how much happened relative to the busiest day on
		     screen. Every cell is a real button, so the keyboard can walk it. -->
		<section class="card heat-card ll-rise" style="animation-delay: 120ms">
			<div class="heat-scroll" bind:this={scroller}>
				<div class="heat" style:--columns={WEEKS}>
					<div class="months" aria-hidden="true">
						{#each months as month (month.column)}
							<span class="month" style:grid-column-start={month.column + 1}>{month.label}</span>
						{/each}
					</div>
					<div class="weekdays" aria-hidden="true">
						{#each weekdayLetters as { row, letter } (row)}
							<span class="weekday" style:grid-row-start={row + 1}>{letter}</span>
						{/each}
					</div>
					<div class="grid" role="group" aria-label="The last {WEEKS} weeks, one cell a day">
						{#each weeks as week, column (week[0])}
							{#each week as day (day)}
								{@const future = day > today}
								<button
									type="button"
									class="cell shade-{shadeOf(activityOf(byDay.get(day)), peak)}"
									class:is-today={day === today}
									class:is-selected={day === selected}
									class:is-future={future}
									style:grid-column-start={column + 1}
									disabled={future}
									aria-label={describe(day)}
									aria-pressed={day === selected}
									title={future ? undefined : describe(day)}
									onclick={() => (selected = day)}
								></button>
							{/each}
						{/each}
					</div>
				</div>
			</div>
			<p class="key" aria-hidden="true">
				<span>Less</span>
				<span class="cell shade-0"></span>
				<span class="cell shade-1"></span>
				<span class="cell shade-2"></span>
				<span class="cell shade-3"></span>
				<span class="cell shade-4"></span>
				<span>More</span>
			</p>
		</section>

		<div class="spread">
			<!-- One day, opened. -->
			<section class="card day-card ll-rise" style="animation-delay: 180ms">
				<p class="eyebrow">{selected === today ? 'Today' : 'That day'}</p>
				<h2 class="day-title">{titleOf(selected)}</h2>
				<hr class="stitch" />

				{#if !current}
					<p class="nothing">Nothing yet.</p>
				{:else}
					<dl class="facts">
						{#if current.count > 0}
							<div class="fact">
								<dt>Answers</dt>
								<dd>
									{current.count}
									<span class="sub"
										>{pct(current.correct + current.almost, current.count)}% right</span
									>
								</dd>
								<!-- The verdicts as one bar in the banner's three inks: what the
								     session felt like, without a number per colour. -->
								<div
									class="verdicts"
									role="img"
									aria-label="{current.correct} correct, {current.almost} almost, {current.wrong} wrong"
								>
									{#if current.correct > 0}
										<span class="v-correct" style="flex-grow: {current.correct}"></span>
									{/if}
									{#if current.almost > 0}
										<span class="v-almost" style="flex-grow: {current.almost}"></span>
									{/if}
									{#if current.wrong > 0}
										<span class="v-wrong" style="flex-grow: {current.wrong}"></span>
									{/if}
								</div>
							</div>
						{/if}
						{#if current.reviewed > 0}
							<div class="fact">
								<dt>Words reviewed</dt>
								<dd>{current.reviewed}</dd>
							</div>
						{/if}
						{#if current.lookups > 0}
							<div class="fact">
								<dt>Looked up</dt>
								<dd>{current.lookups}</dd>
							</div>
						{/if}
						{#if current.added > 0}
							<div class="fact">
								<dt>Words added</dt>
								<dd>{current.added}</dd>
							</div>
						{/if}
					</dl>
				{/if}
			</section>

			<!-- The ledger: the same days as rows, newest first, each a way to open it. -->
			<section class="card ledger-card ll-rise" style="animation-delay: 240ms">
				<div class="card-head">
					<h2>Every day</h2>
					<span class="entry-count">{ledger.length} day{ledger.length === 1 ? '' : 's'}</span>
				</div>
				<hr class="stitch" />

				{#if ledger.length === 0}
					<p class="nothing">Your first session writes the first day.</p>
				{:else}
					<ol class="ledger">
						{#each shown as entry (entry.day)}
							<li>
								<button
									type="button"
									class="row"
									class:is-selected={entry.day === selected}
									aria-pressed={entry.day === selected}
									onclick={() => (selected = entry.day)}
								>
									<span class="row-date">
										{entry.day === today ? 'Today' : shortDate.format(dateOf(entry.day))}
									</span>
									<span class="row-facts">
										{#if entry.count > 0}
											<span class="row-fact">
												<b>{entry.count}</b> answer{entry.count === 1 ? '' : 's'}
											</span>
										{/if}
										{#if entry.reviewed > 0}
											<span class="row-fact"><b>{entry.reviewed}</b> reviewed</span>
										{/if}
										{#if entry.lookups > 0}
											<span class="row-fact"><b>{entry.lookups}</b> looked up</span>
										{/if}
										{#if entry.added > 0}
											<span class="row-fact"><b>{entry.added}</b> added</span>
										{/if}
									</span>
								</button>
							</li>
						{/each}
					</ol>
					{#if !showAll && ledger.length > LEDGER_PAGE}
						<button type="button" class="btn btn-ghost more" onclick={() => (showAll = true)}>
							Show all {ledger.length} days
						</button>
					{/if}
				{/if}
			</section>
		</div>
	{/if}
</main>

<style>
	/* Width and the side gutter are the global `.shell`/`.shell-broad` pair's;
	   the calendar is the one wide thing here and scrolls inside its own card. */
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

	.topbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.identity {
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.05rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.55rem;
		line-height: 1.1;
	}

	/* The figures, in the garden's tiles. Not buttons here: nothing to filter. */
	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(5rem, 1fr));
		gap: 0.5rem;
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 0.05rem;
		padding: 0.55rem 0.6rem;
		border: 1px solid var(--border);
		border-bottom-width: 3px;
		border-radius: var(--radius);
		background: var(--surface);
	}

	.tile-num {
		font-family: var(--font-display);
		font-size: 1.3rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.tile-num.accented {
		color: var(--primary-strong);
	}

	.tile-label {
		font-size: 0.63rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* The calendar --------------------------------------------------------- */

	.heat-card {
		max-width: none;
		padding-block: 1.25rem 1rem;
	}

	/* Wide content scrolls inside its own container; the page never does. */
	.heat-scroll {
		overflow-x: auto;
		padding-bottom: 0.25rem;
		scrollbar-width: thin;
	}

	/* One cell size drives every track, so the month row, the weekday column
	   and the grid line up by construction rather than by measurement. */
	.heat {
		--cell: 0.8rem;
		--cell-gap: 3px;
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto auto;
		column-gap: 0.4rem;
		row-gap: 0.3rem;
		width: max-content;
	}

	.months {
		grid-column: 2;
		grid-row: 1;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: var(--cell);
		gap: var(--cell-gap);
		height: 1rem;
	}

	.month {
		grid-row: 1;
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.weekdays {
		grid-column: 1;
		grid-row: 2;
		display: grid;
		grid-template-rows: repeat(7, var(--cell));
		gap: var(--cell-gap);
	}

	.weekday {
		display: flex;
		align-items: center;
		font-size: 0.62rem;
		font-weight: 700;
		color: var(--text-muted);
	}

	.grid {
		grid-column: 2;
		grid-row: 2;
		display: grid;
		grid-template-rows: repeat(7, var(--cell));
		grid-template-columns: repeat(var(--columns), var(--cell));
		grid-auto-flow: column;
		gap: var(--cell-gap);
	}

	/* A pressed specimen, not a pixel: hairline and a small radius, with the
	   shade a mix of leaf green into the page. */
	.cell {
		display: block;
		width: var(--cell);
		height: var(--cell);
		padding: 0;
		border: 1px solid transparent;
		border-radius: 3px;
		background: var(--surface-alt);
		cursor: pointer;
		transition:
			transform 0.08s ease,
			box-shadow 0.15s ease;
	}

	.cell.shade-1 {
		background: color-mix(in srgb, var(--primary) 30%, var(--surface-alt));
	}

	.cell.shade-2 {
		background: color-mix(in srgb, var(--primary) 52%, var(--surface-alt));
	}

	.cell.shade-3 {
		background: color-mix(in srgb, var(--primary) 76%, var(--surface-alt));
	}

	.cell.shade-4 {
		background: var(--primary-strong);
	}

	.cell:hover:not(:disabled) {
		transform: scale(1.18);
	}

	.cell:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.cell.is-today {
		border-color: var(--text);
	}

	.cell.is-selected {
		box-shadow: 0 0 0 2px var(--accent);
	}

	.cell.is-future {
		background: transparent;
		border-color: var(--border);
		border-style: dashed;
		cursor: default;
	}

	.key {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.25rem;
		margin: 0.6rem 0 0;
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.key .cell {
		--cell: 0.65rem;
		cursor: default;
	}

	.key span:first-child {
		margin-right: 0.2rem;
	}

	.key span:last-child {
		margin-left: 0.2rem;
	}

	/* One day --------------------------------------------------------------- */

	.day-title {
		margin: 0;
		font-size: 1.3rem;
	}

	.nothing {
		margin: 0;
		color: var(--text-muted);
	}

	.facts {
		display: grid;
		gap: 0.85rem;
		margin: 0;
	}

	.fact dt {
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.fact dd {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		margin: 0.1rem 0 0;
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.fact .sub {
		font-family: var(--font);
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	.verdicts {
		display: flex;
		gap: 2px;
		height: 0.5rem;
		margin-top: 0.45rem;
		border-radius: 999px;
		overflow: hidden;
		background: var(--surface-alt);
	}

	.verdicts span {
		flex-basis: 0;
		min-width: 3px;
	}

	.v-correct {
		background: var(--primary);
	}

	.v-almost {
		background: var(--amber);
	}

	.v-wrong {
		background: var(--danger);
	}

	/* The ledger ----------------------------------------------------------- */

	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.card-head h2 {
		margin: 0;
		font-size: 1.15rem;
	}

	.entry-count {
		font-size: 0.82rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.ledger {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.ledger li + li {
		border-top: 1px dashed var(--border);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.75rem;
		width: 100%;
		padding: 0.55rem 0.4rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.row:hover {
		background: var(--surface-alt);
	}

	.row:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.row.is-selected {
		background: var(--primary-soft);
	}

	.row-date {
		flex: 0 0 6.5rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.row-facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.7rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.row-fact b {
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}

	.more {
		width: 100%;
		margin-top: 0.6rem;
	}

	.error {
		margin: 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-weight: 700;
	}

	@media (min-width: 48rem) {
		/* The spread's usual asymmetry: the one day is the smaller page, the
		   ledger the longer one. */
		.spread {
			grid-template-columns: 2fr 3fr;
		}
	}
</style>
