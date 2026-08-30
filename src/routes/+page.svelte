<script lang="ts">
	import { browser } from '$app/environment';

	import {
		getAllItems,
		getDailyActivity,
		getProfile,
		localDay,
		poolSize,
		previousDay,
		streakFrom
	} from '$lib/db';
	import { maturityOf, type Maturity } from '$lib/session/progression';
	import { isDue, type FsrsCardState } from '$lib/srs';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	/** Days in the activity strip, ending today. */
	const STRIP_DAYS = 7;

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	/** Answers per local calendar day, oldest first — the strip and the streak. */
	let activity = $state<{ day: string; count: number }[]>([]);
	/** The run of consecutive days with an answer in it, folded out of the log. */
	let streakDays = $state(0);
	let now = $state(Date.now());
	/** Challenges in the pool — an upper bound on what a session could draw from. */
	let pooled = $state(0);

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems(), getDailyActivity(), poolSize()])
			.then(([loadedProfile, loadedItems, days, count]) => {
				if (cancelled) return;
				profile = loadedProfile;
				items = loadedItems;
				activity = days;
				streakDays = streakFrom(activity.map((entry) => entry.day));
				pooled = count;
				now = Date.now();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your progress.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/** `fsrsCard` is `unknown` on the domain type; a missing card means "brand new". */
	function cardState(item: KnowledgeItem): FsrsCardState | null {
		return (item.fsrsCard as FsrsCardState | null | undefined) ?? null;
	}

	const targetLanguage = $derived(profile?.targetLanguage?.trim() || 'your new language');
	const dueCount = $derived(
		items.filter((item) => {
			const card = cardState(item);
			return !card || isDue(card, now);
		}).length
	);

	const today = $derived(localDay(now));
	const reviewsToday = $derived(activity.find((entry) => entry.day === today)?.count ?? 0);

	/**
	 * The line under the headline. It is about *today*, so it has to stay
	 * pleasant on the day nothing has happened yet — an empty log is a fine way
	 * to be, and the card never scolds.
	 */
	const secondaryLine = $derived(
		reviewsToday > 0
			? `${reviewsToday} review${reviewsToday === 1 ? '' : 's'} done today`
			: dueCount > 0
				? 'Nothing answered yet today'
				: 'Nothing waiting — more words ripen as the day goes on'
	);

	interface DayCell {
		day: string;
		count: number;
		/** Single-letter weekday label, in the reader's own locale. */
		letter: string;
		isToday: boolean;
	}

	/**
	 * The last seven calendar days, oldest first. Built by walking `previousDay`
	 * backwards from today rather than by slicing the log, so unplayed days are
	 * present as zeroes instead of missing columns.
	 */
	const strip: DayCell[] = $derived.by(() => {
		const counts = new Map(activity.map((entry) => [entry.day, entry.count]));

		const days = [today];
		while (days.length < STRIP_DAYS) days.unshift(previousDay(days[0]));

		return days.map((day) => {
			const [year, month, date] = day.split('-').map(Number);
			return {
				day,
				count: counts.get(day) ?? 0,
				letter: new Date(year, month - 1, date).toLocaleDateString(undefined, {
					weekday: 'narrow'
				}),
				isToday: day === today
			};
		});
	});

	const stripPeak = $derived(Math.max(1, ...strip.map((cell) => cell.count)));

	/**
	 * Bar height as a percentage of the column. A day with answers never drops
	 * below a readable stub, so a quiet day next to a heavy one still reads as
	 * "something happened" rather than as nothing.
	 */
	function barHeight(count: number): number {
		if (count === 0) return 0;
		return Math.max(18, Math.round((count / stripPeak) * 100));
	}

	/**
	 * The garden's three beds. Botanical rather than clinical on purpose: this
	 * card is about growth, so nothing here is coloured or worded as a problem.
	 */
	const BEDS: { maturity: Maturity; label: string }[] = [
		{ maturity: 'new', label: 'sprouting' },
		{ maturity: 'young', label: 'growing' },
		{ maturity: 'solid', label: 'rooted' }
	];

	const garden = $derived.by(() => {
		const counts: Record<Maturity, number> = { new: 0, young: 0, solid: 0 };
		for (const item of items) counts[maturityOf(item, now)]++;
		return BEDS.map((bed) => ({ ...bed, count: counts[bed.maturity] }));
	});

	const gardenLabel = $derived(garden.map((bed) => `${bed.count} ${bed.label}`).join(', '));
</script>

<svelte:head>
	<title>{profile ? `Sapling · ${targetLanguage}` : 'Sapling'}</title>
</svelte:head>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else}
		<!-- A field journal opened wide is a spread: the topbar is the running
		     head across both pages, then the *doing* (start a session, have a
		     conversation) and the *state* (right now, the garden) split into
		     facing columns. On a phone `.spread` collapses to one column, which
		     reproduces the original stacking order exactly. -->
		<div class="spread home-spread">
			<header class="topbar spread-full ll-rise">
				<div class="identity">
					<p class="eyebrow">Learning</p>
					<h1>{targetLanguage}</h1>
				</div>
				<div class="topbar-actions">
					<div class="streak" class:dimmed={streakDays === 0} title="Current streak">
						<svg class="ico sprout" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M12 21v-8.6" />
							<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
							<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
						</svg>
						<span>{streakDays}</span>
					</div>
					<a class="gear" href="/chat" aria-label="Assistant">
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
							<path
								d="M20.3 12.2c0 4-3.7 7.2-8.2 7.2a9.4 9.4 0 0 1-2.5-.3L4.6 20.5l1.3-3.7a6.9 6.9 0 0 1-2.2-4.6C3.7 8.2 7.4 5 11.9 5s8.4 3.2 8.4 7.2Z"
							/>
							<path d="M9 11.9h.01M12 11.9h.01M15 11.9h.01" />
						</svg>
					</a>
					<!-- No conversation icon here: it has the card below. One of the two
					     ways vocabulary enters the app does not belong in the corner row
					     with settings. -->
					<a class="gear" href="/profile" aria-label="Profile">
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
							<circle cx="12" cy="8.4" r="3.4" />
							<path d="M4.9 19.6c.7-3.4 3.5-5.5 7.1-5.5s6.4 2.1 7.1 5.5" />
						</svg>
					</a>
					<a class="gear" href="/settings" aria-label="Settings">
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M4 8.2h8.4M17.4 8.2H20M4 15.8h2.6M11.6 15.8H20" />
							<circle cx="15" cy="8.2" r="2.3" />
							<circle cx="9" cy="15.8" r="2.3" />
						</svg>
					</a>
				</div>
			</header>

			<!-- Doing: the two ways to act right now. -->
			<div class="col-do">
				<section class="card start-card ll-rise" style="animation-delay: 120ms">
					<svg class="watermark" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M12 21v-8.6" />
						<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
						<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
					</svg>
					<!-- A session only revisits words the learner already has, so on an empty
					     garden "Start session" would open onto nothing. The card hands its
					     primary button over to the two places words actually come from, and
					     takes it back the moment there is something to review. -->
					{#if items.length === 0}
						<p class="start-lead">
							Nothing planted yet — your first words in {targetLanguage} come from talking.
						</p>
						<a class="btn btn-primary btn-block start-btn" href="/converse">Start a conversation</a>
						<a class="btn btn-ghost btn-block ask-link" href="/chat"
							>Or ask the assistant for a few</a
						>
					{:else}
						<a class="btn btn-primary btn-block start-btn" href="/learn">Start session</a>
						<!-- Only the empty pool speaks here. The due count is the card below's
						     job, and a number stated twice on one screen invites the two to
						     disagree. -->
						{#if pooled === 0}
							<p class="hint centered">
								No challenges waiting — a new lesson grows a fresh set from the words you have.
							</p>
						{/if}
					{/if}
				</section>

				<!-- Conversation sits directly under the drill because the two are peers
				     with different jobs: a session revisits what is already growing, this
				     is where new words enter at all. Quieter than the start card by a
				     whole background, but a card rather than a topbar icon — one of the
				     two ways vocabulary arrives cannot live in a corner.

				     Skipped on an empty garden, where the start card above is already
				     this same door and one screen does not need it twice. -->
				{#if items.length > 0}
					<section class="card talk-card ll-rise" style="animation-delay: 180ms">
						<a class="talk-link" href="/converse">
							<span class="talk-mark" aria-hidden="true">
								<svg class="ico" viewBox="0 0 24 24">
									<path d="M4.6 6.4h9.6v7.2H8.2l-3.6 3v-3H4.6Z" />
									<path d="M10.6 9.4h8.8v6.2h-2.4v2.6l-3-2.6h-3.4Z" />
								</svg>
							</span>
							<span class="talk-body">
								<span class="talk-title">Have a conversation</span>
								<span class="talk-copy">
									A scene you talk your way through — new words get planted as you reach for them.
								</span>
							</span>
							<svg class="ico talk-arrow" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M4.8 12h14" />
								<path d="m13.4 6.6 5.4 5.4-5.4 5.4" />
							</svg>
						</a>
					</section>
				{/if}
			</div>

			<!-- State: where things stand, read rather than acted on. -->
			<div class="col-state">
				<!-- "Right now", never "today": due counts move through the day as words
				     fall due, so this card states a moment rather than scoring a day. -->
				<section class="card now-card ll-rise" style="animation-delay: 240ms">
					<p class="eyebrow">Right now</p>
					<p class="now-headline">
						{#if dueCount === 0}
							You're all caught up
						{:else}
							{dueCount} word{dueCount === 1 ? '' : 's'} ready to review
						{/if}
					</p>
					<p class="now-secondary">{secondaryLine}</p>

					<hr class="stitch" />

					<div
						class="strip"
						role="img"
						aria-label={`Answers over the last ${STRIP_DAYS} days: ${strip.map((cell) => `${cell.day}, ${cell.count}`).join('; ')}`}
					>
						{#each strip as cell (cell.day)}
							<div class="strip-col" class:is-today={cell.isToday}>
								<div class="strip-track">
									{#if cell.count > 0}
										<div class="strip-bar" style="height: {barHeight(cell.count)}%"></div>
									{:else}
										<div class="strip-stub"></div>
									{/if}
								</div>
								<span class="strip-letter">{cell.letter}</span>
							</div>
						{/each}
					</div>
				</section>

				{#if items.length > 0}
					<section class="card garden-card ll-rise" style="animation-delay: 300ms">
						<div class="card-head">
							<h2>Garden</h2>
							<div class="card-tools">
								<span class="card-count">{items.length} word{items.length === 1 ? '' : 's'}</span>
								<a class="btn btn-ghost words-link" href="/words">Full garden</a>
							</div>
						</div>
						<hr class="stitch" />

						<div class="beds" role="img" aria-label={`Vocabulary: ${gardenLabel}`}>
							{#each garden as bed (bed.maturity)}
								{#if bed.count > 0}
									<div class="bed bed-{bed.maturity}" style="flex-grow: {bed.count}"></div>
								{/if}
							{/each}
						</div>

						<ul class="legend">
							{#each garden as bed (bed.maturity)}
								<li class="legend-item">
									<span class="dot bed-{bed.maturity}" aria-hidden="true"></span>
									<span class="legend-count">{bed.count}</span>
									<span class="legend-label">{bed.label}</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>
		</div>
	{/if}
</main>

<style>
	/* Width and horizontal padding are the global `.shell`'s job — the
	   `.shell-broad` modifier in the markup caps this page at
	   `--measure-broad`, room enough for the spread below. Only the vertical
	   rhythm is this route's own. */
	.shell {
		padding-block: 2rem 4rem;
		display: flex;
		flex-direction: column;
		gap: var(--gap);
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	/* Doing and state are ordinary flex stacks inside the spread's two grid
	   columns — the grid only decides the arrangement, each side still
	   controls its own card rhythm. */
	.col-do,
	.col-state {
		display: flex;
		flex-direction: column;
		gap: var(--gap);
	}

	@media (min-width: 72rem) {
		/* Full desktop: starting a session or a conversation is the louder,
		   primary path through this page, so the doing column gets more of
		   the extra width than the read-only state column opposite it. */
		.home-spread {
			grid-template-columns: 3fr 2fr;
		}
	}

	/* Every icon on this screen is the same hand: 24-unit box, hairline stroke,
	   round joins. The attributes live here rather than on each <svg> so the
	   markup stays readable and the weight can never drift between icons. */
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

	.topbar {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.identity {
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.1rem;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: clamp(1.75rem, 8vw, 2.3rem);
		line-height: 1.05;
		overflow-wrap: break-word;
	}

	.topbar-actions {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		/* Optically aligned with the language name, not the eyebrow above it. */
		padding-top: 0.15rem;
	}

	/* Topbar controls are label tabs, not pills: the same 2.25rem square with a
	   hairline and a squared-off radius, so the streak count reads as one of
	   the row rather than a badge stuck onto it. */
	.streak,
	.gear {
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.streak {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0 0.6rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.sprout {
		color: var(--primary);
	}

	.streak.dimmed {
		opacity: 0.5;
		filter: grayscale(0.7);
	}

	.gear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		color: var(--text-muted);
		text-decoration: none;
	}

	.gear:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.gear:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* Scoped to the spread — the column already bounds these, and below 48rem
	   the shell can outgrow a card. The load-error card sits outside it and
	   keeps the reading measure: one sentence has no use for 64rem. */
	.spread .card {
		max-width: none;
	}

	.card-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}

	.card-head h2 {
		margin: 0;
		font-size: 1.15rem;
	}

	.card-tools {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.card-count {
		font-size: 0.82rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.02em;
		color: var(--text-muted);
	}

	.card-head + .stitch {
		margin: 0 0 1rem;
	}

	.words-link {
		padding: 0.28rem 0.7rem;
		border-color: var(--border);
		font-size: 0.78rem;
		/* An anchor wearing .btn arrives underlined; the control must read as a
		   button, not a link in a box. */
		text-decoration: none;
	}

	.start-card {
		position: relative;
		/* Own stacking context, so the watermark's `z-index: -1` lands behind
		   the button and above the card's own background rather than escaping
		   to the page. */
		isolation: isolate;
		overflow: hidden;
		text-align: center;
		background:
			linear-gradient(
				160deg,
				color-mix(in srgb, var(--primary-soft) 70%, var(--surface)),
				var(--surface) 62%
			),
			var(--surface);
	}

	/* The brand sprout, pressed faintly into the page behind the one button
	   that matters. Used exactly once in the app — a watermark stops being a
	   watermark the moment it repeats. */
	.watermark {
		position: absolute;
		z-index: -1;
		right: -1.4rem;
		bottom: -2rem;
		width: 9.5rem;
		height: 9.5rem;
		fill: none;
		stroke: var(--primary);
		stroke-width: 1.1;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.12;
		pointer-events: none;
	}

	.start-btn {
		font-size: 1.05rem;
		padding: 1.05rem 1.5rem;
		letter-spacing: 0.005em;
	}

	.hint.centered {
		margin: 0.9rem 0 0;
		text-align: center;
		text-wrap: balance;
	}

	/* The empty garden's line sits *above* its button, unlike the hints, because
	   here it is the reason for the button rather than a footnote to it. */
	.start-lead {
		margin: 0 0 1rem;
		font-family: var(--font-display);
		font-size: 1.05rem;
		font-weight: 700;
		line-height: 1.3;
		letter-spacing: -0.01em;
		text-wrap: balance;
	}

	.ask-link {
		margin-top: 0.55rem;
		font-size: 0.85rem;
		/* An anchor wearing .btn arrives underlined. */
		text-decoration: none;
	}

	/* Conversation -------------------------------------------------------- */

	/* The whole card is the target — on a phone this should not require finding
	   a button inside it — so the padding moves off the card and onto the link.
	   It keeps the plain surface while the start card above keeps the wash:
	   same footprint, one step quieter. */
	.talk-card {
		padding: 0;
		overflow: hidden;
	}

	.talk-link {
		display: flex;
		align-items: center;
		gap: 0.9rem;
		padding: 1.15rem 1.25rem;
		color: var(--text);
		text-decoration: none;
		transition: background 0.15s ease;
	}

	.talk-link:hover {
		background: var(--surface-alt);
	}

	.talk-link:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.talk-mark {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: 50%;
		background: var(--primary-soft);
		color: var(--primary);
	}

	.talk-mark .ico {
		width: 1.35rem;
		height: 1.35rem;
	}

	.talk-body {
		min-width: 0;
	}

	.talk-title {
		display: block;
		font-family: var(--font-display);
		font-size: 1.05rem;
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.talk-copy {
		display: block;
		margin-top: 0.15rem;
		font-size: 0.85rem;
		line-height: 1.4;
		color: var(--text-muted);
		text-wrap: balance;
	}

	.talk-arrow {
		margin-left: auto;
		color: var(--text-muted);
	}

	/* Right now ---------------------------------------------------------- */

	.now-headline {
		margin: 0.15rem 0 0;
		font-family: var(--font-display);
		font-size: clamp(1.25rem, 5.5vw, 1.5rem);
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		text-wrap: balance;
	}

	.now-secondary {
		margin: 0.3rem 0 0;
		font-size: 0.9rem;
		color: var(--text-muted);
		text-wrap: balance;
	}

	.now-card .stitch {
		margin: 1.1rem 0 0.85rem;
	}

	/* Seven days of answers, drawn in the page's own ink. Deliberately unlabelled
	   on the vertical axis: it is a shape to recognise at a glance, not a chart
	   to read values off. */
	.strip {
		display: flex;
		align-items: flex-end;
		gap: 0.4rem;
	}

	.strip-col {
		flex: 1 1 0;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.35rem;
	}

	.strip-track {
		display: flex;
		align-items: flex-end;
		height: 2.6rem;
	}

	@media (min-width: 48rem) {
		/* The spread gives the "Right now" card a whole column to itself, so
		   the strip can stand taller and read as less cramped. */
		.strip-track {
			height: 3.4rem;
		}
	}

	.strip-bar {
		width: 100%;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--primary) 45%, var(--surface-alt));
	}

	/* A day with nothing in it is still a day: a hairline sitting on the
	   baseline, not a gap. */
	.strip-stub {
		width: 100%;
		height: 2px;
		border-radius: 2px;
		background: var(--border-strong);
		opacity: 0.7;
	}

	.strip-letter {
		text-align: center;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.strip-col.is-today .strip-bar {
		background: var(--primary);
	}

	.strip-col.is-today .strip-stub {
		background: var(--primary);
		opacity: 0.55;
	}

	.strip-col.is-today .strip-letter {
		color: var(--text);
	}

	/* Garden ------------------------------------------------------------- */

	/* One bar, three beds. Segment widths come from `flex-grow: count`, so they
	   partition the bar exactly — percentages would have to be rounded, and
	   rounded percentages do not add up to a whole garden. */
	.beds {
		display: flex;
		gap: 2px;
		height: 0.85rem;
		border-radius: 999px;
		background: var(--surface-alt);
		overflow: hidden;
	}

	@media (min-width: 48rem) {
		/* Same reasoning as the activity strip above: a column of its own
		   buys the garden bar a bit more presence. */
		.beds {
			height: 1.1rem;
		}
	}

	.bed {
		flex-basis: 0;
		min-width: 3px;
	}

	.bed-new {
		background: var(--accent);
	}

	.bed-young {
		background: color-mix(in srgb, var(--primary) 55%, var(--amber));
	}

	.bed-solid {
		background: var(--primary);
	}

	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 1.1rem;
		margin: 0.85rem 0 0;
		padding: 0;
	}

	.legend-item {
		display: inline-flex;
		align-items: baseline;
		gap: 0.35rem;
		font-size: 0.85rem;
	}

	.dot {
		align-self: center;
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		flex: 0 0 auto;
	}

	.legend-count {
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.legend-label {
		color: var(--text-muted);
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

	@media (max-width: 380px) {
		/* At the narrowest phone the language name needs the whole line; the
		   controls drop under it rather than squeezing the headline. */
		.topbar {
			flex-direction: column;
			align-items: stretch;
		}

		.topbar-actions {
			padding-top: 0;
		}

		/* The copy is what has to survive here, so the row gives back its own
		   padding and gaps rather than squeezing the line to three words. */
		.talk-link {
			gap: 0.7rem;
			padding: 1rem;
		}

		.talk-mark {
			width: 2.2rem;
			height: 2.2rem;
		}

		.legend {
			gap: 0.35rem 0.8rem;
		}
	}
</style>
