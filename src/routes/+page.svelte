<script lang="ts">
	import { browser } from '$app/environment';

	import { maturityOf, type Maturity } from '$lib/challenges/serve/progression';
	import {
		getAllItems,
		getConversations,
		getDailyActivity,
		getProfile,
		getTexts,
		localDay,
		previousDay,
		streakFrom
	} from '$lib/db';
	import type { ConversationSummary } from '$lib/db';
	import { isDue } from '$lib/srs';
	import type { KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	const STRIP_DAYS = 7;

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let activity = $state<{ day: string; count: number }[]>([]);
	let conversations = $state<ConversationSummary[]>([]);
	let texts = $state<ReadingText[]>([]);
	let streakDays = $state(0);
	let now = $state(Date.now());

	$effect(() => {
		if (!browser) return;
		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems(), getDailyActivity(), getConversations(), getTexts()])
			.then(([loadedProfile, loadedItems, days, loadedConversations, loadedTexts]) => {
				if (cancelled) return;
				profile = loadedProfile;
				items = loadedItems;
				activity = days;
				conversations = loadedConversations;
				texts = loadedTexts;
				streakDays = streakFrom(days.map((entry) => entry.day));
				now = Date.now();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your day.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	const targetLanguage = $derived(profile?.targetLanguage?.trim() || 'your new language');
	const dueCount = $derived(items.filter((item) => isDue(item, now)).length);
	const today = $derived(localDay(now));
	const reviewsToday = $derived(activity.find((entry) => entry.day === today)?.count ?? 0);

	const recommendation = $derived.by(() => {
		if (items.length === 0) {
			return {
				kicker: 'Start your garden',
				title: `Plant your first ${targetLanguage} words`,
				copy: 'Meet useful words in a conversation or a text. The ones you keep will return here for practice.',
				label: 'Explore your language',
				href: '/explore'
			};
		}
		if (dueCount > 0) {
			return {
				kicker: 'Ready to tend',
				title: `${dueCount} word${dueCount === 1 ? '' : 's'} ready`,
				copy:
					reviewsToday > 0
						? `You have already completed ${reviewsToday} review${reviewsToday === 1 ? '' : 's'} today. These words are ready for another look.`
						: 'A short practice session will focus on the words most likely to fade next.',
				label: 'Practice now',
				href: '/learn'
			};
		}
		return {
			kicker: 'All tended',
			title: 'Your garden is caught up',
			copy:
				reviewsToday > 0
					? `${reviewsToday} review${reviewsToday === 1 ? '' : 's'} completed today. Nothing else needs attention right now.`
					: 'Nothing needs review right now. This is a good moment to encounter something new.',
			label: 'Explore something new',
			href: '/explore'
		};
	});

	interface ContinueItem {
		id: string;
		title: string;
		meta: string;
		href: string;
		at: number;
		kind: 'conversation' | 'reading';
	}

	const continueItems = $derived.by((): ContinueItem[] => {
		const rows: ContinueItem[] = [
			...conversations.map((conversation) => ({
				id: `conversation-${conversation.id}`,
				title: conversation.topic?.trim() || conversation.scenario.setting,
				meta: `${conversation.turnCount} turn${conversation.turnCount === 1 ? '' : 's'}`,
				href: `/converse/${conversation.id}`,
				at: conversation.lastTurnAt ?? conversation.createdAt,
				kind: 'conversation' as const
			})),
			...texts.map((text) => ({
				id: `reading-${text.id}`,
				title: text.title,
				meta: text.media ? 'Watch or read again' : 'Continue reading',
				href: `/read/${text.id}`,
				at: text.createdAt,
				kind: 'reading' as const
			}))
		];
		return rows.sort((a, b) => b.at - a.at).slice(0, 3);
	});

	interface DayCell {
		day: string;
		count: number;
		letter: string;
		isToday: boolean;
	}

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
	function barHeight(count: number): number {
		return count === 0 ? 0 : Math.max(18, Math.round((count / stripPeak) * 100));
	}

	const BEDS: { maturity: Maturity; label: string }[] = [
		{ maturity: 'new', label: 'sprouting' },
		{ maturity: 'young', label: 'growing' },
		{ maturity: 'solid', label: 'rooted' }
	];

	const garden = $derived.by(() => {
		const counts: Record<Maturity, number> = { new: 0, young: 0, solid: 0 };
		for (const item of items) counts[maturityOf(item)]++;
		return BEDS.map((bed) => ({ ...bed, count: counts[bed.maturity] }));
	});

	const gardenLabel = $derived(garden.map((bed) => `${bed.count} ${bed.label}`).join(', '));
</script>

<svelte:head>
	<title>{profile ? `Sapling · ${targetLanguage}` : 'Sapling'}</title>
</svelte:head>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading"><Spinner /></div>
	{:else if loadError}
		<div class="card"><p class="error" role="alert">{loadError}</p></div>
	{:else}
		<header class="today-header ll-rise">
			<div class="identity">
				<p class="eyebrow">Learning {targetLanguage}</p>
				<h1>Today</h1>
			</div>

			<div class="header-tools">
				<div class="streak" class:quiet={streakDays === 0} aria-label={`${streakDays} day streak`}>
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M12 21v-8.6" />
						<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
						<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
					</svg>
					<span>{streakDays}</span>
				</div>
			</div>
		</header>

		<section class="hero ll-rise" style="animation-delay: 70ms">
			<svg class="hero-sprout" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M12 21v-8.6" />
				<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
				<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
			</svg>
			<div class="hero-copy">
				<p class="hero-kicker">{recommendation.kicker}</p>
				<h2>{recommendation.title}</h2>
				<p>{recommendation.copy}</p>
			</div>
			<a class="btn btn-primary hero-action" href={recommendation.href}>
				{recommendation.label}
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.8 12h14" /><path d="m13.4 6.6 5.4 5.4-5.4 5.4" />
				</svg>
			</a>
		</section>

		<div class="today-grid" class:without-continue={continueItems.length === 0}>
			{#if continueItems.length > 0}
				<section class="card continue-card ll-rise" style="animation-delay: 130ms">
					<div class="section-head">
						<div>
							<p class="eyebrow">Pick up where you left off</p>
							<h2>Continue</h2>
						</div>
						<a href="/explore">All activities</a>
					</div>
					<div class="continue-list">
						{#each continueItems as item (item.id)}
							<a class="continue-row" href={item.href}>
								<span class="continue-mark" aria-hidden="true">
									{#if item.kind === 'conversation'}
										<svg class="ico" viewBox="0 0 24 24"
											><path d="M4.6 6.4h9.6v7.2H8.2l-3.6 3v-3H4.6Z" /><path
												d="M10.6 9.4h8.8v6.2h-2.4v2.6l-3-2.6h-3.4Z"
											/></svg
										>
									{:else}
										<svg class="ico" viewBox="0 0 24 24"
											><path d="M12 7.4C9.9 6 7 5.4 3.8 5.6v11.6c3.2-.2 6.1.4 8.2 1.8" /><path
												d="M12 7.4c2.1-1.4 5-2 8.2-1.8v11.6c-3.2-.2-6.1.4-8.2 1.8"
											/></svg
										>
									{/if}
								</span>
								<span class="continue-copy"
									><strong>{item.title}</strong><small>{item.meta}</small></span
								>
								<svg class="ico row-arrow" viewBox="0 0 24 24" aria-hidden="true"
									><path d="m9 5.5 6.5 6.5L9 18.5" /></svg
								>
							</a>
						{/each}
					</div>
				</section>
			{/if}

			<div class="state-stack">
				<section class="card garden-card ll-rise" style="animation-delay: 190ms">
					<div class="section-head compact">
						<div>
							<p class="eyebrow">Your collection</p>
							<h2>Garden</h2>
						</div>
						<a href="/words">View all</a>
					</div>
					<p class="garden-total">{items.length}<span>word{items.length === 1 ? '' : 's'}</span></p>
					<div class="beds" role="img" aria-label={`Vocabulary: ${gardenLabel}`}>
						{#each garden as bed (bed.maturity)}
							{#if bed.count > 0}<span
									class="bed bed-{bed.maturity}"
									style={`flex-grow: ${bed.count}`}
								></span>{/if}
						{/each}
					</div>
					<ul class="legend">
						{#each garden as bed (bed.maturity)}
							<li>
								<span class="dot bed-{bed.maturity}"></span><strong>{bed.count}</strong>
								{bed.label}
							</li>
						{/each}
					</ul>
				</section>

				<section class="card activity-card ll-rise" style="animation-delay: 250ms">
					<div class="section-head compact">
						<div>
							<p class="eyebrow">Last seven days</p>
							<h2>Activity</h2>
						</div>
						<a href="/activity">History</a>
					</div>
					<div
						class="strip"
						role="img"
						aria-label={`Reviews over seven days: ${strip.map((cell) => `${cell.day}, ${cell.count}`).join('; ')}`}
					>
						{#each strip as cell (cell.day)}
							<div class="strip-col" class:today={cell.isToday}>
								<div class="strip-track">
									{#if cell.count > 0}<span
											class="strip-bar"
											style={`height: ${barHeight(cell.count)}%`}
										></span>{/if}
								</div>
								<span>{cell.letter}</span>
							</div>
						{/each}
					</div>
					<p class="activity-note">
						{reviewsToday > 0 ? `${reviewsToday} reviewed today` : 'A quiet day so far'}
					</p>
				</section>
			</div>
		</div>
	{/if}
</main>

<style>
	.shell {
		display: flex;
		flex-direction: column;
		gap: var(--gap);
		padding-block: 2rem 4rem;
	}
	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
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
	.today-header {
		position: relative;
		z-index: 10;
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}
	.identity {
		min-width: 0;
	}
	.eyebrow,
	.hero-kicker {
		margin: 0 0 0.15rem;
		color: color-mix(in srgb, var(--accent) 68%, var(--text-muted));
		font-size: 0.68rem;
		font-weight: 750;
		letter-spacing: 0.13em;
		text-transform: uppercase;
	}
	.today-header h1 {
		margin: 0;
		font-size: clamp(2.2rem, 9vw, 3.5rem);
		line-height: 1;
	}
	.header-tools {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.streak {
		min-height: 2.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
	}
	.streak {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0 0.65rem;
		color: var(--primary-strong);
		font-weight: 750;
	}
	.streak.quiet {
		color: var(--text-muted);
		opacity: 0.65;
	}
	.hero {
		position: relative;
		isolation: isolate;
		display: grid;
		gap: 1.5rem;
		min-height: 20rem;
		overflow: hidden;
		padding: clamp(1.5rem, 5vw, 3.25rem);
		border: 1px solid color-mix(in srgb, var(--primary) 30%, var(--border));
		border-radius: calc(var(--radius-lg) + 4px);
		background: linear-gradient(
			140deg,
			color-mix(in srgb, var(--primary-soft) 82%, var(--surface)),
			var(--surface) 66%
		);
		box-shadow: var(--shadow);
	}
	.hero::after {
		content: '';
		position: absolute;
		z-index: -1;
		right: -8rem;
		bottom: -12rem;
		width: 25rem;
		height: 25rem;
		border: 1px dashed color-mix(in srgb, var(--primary) 24%, transparent);
		border-radius: 50%;
	}
	.hero-sprout {
		position: absolute;
		z-index: -1;
		right: clamp(1rem, 8vw, 6rem);
		bottom: -1.5rem;
		width: clamp(10rem, 25vw, 15rem);
		height: clamp(10rem, 25vw, 15rem);
		fill: none;
		stroke: color-mix(in srgb, var(--primary) 16%, transparent);
		stroke-width: 1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.hero-copy {
		max-width: 36rem;
		align-self: end;
	}
	.hero h2 {
		max-width: 32rem;
		margin: 0.25rem 0 0.75rem;
		font-size: clamp(2rem, 7vw, 3.35rem);
		line-height: 1.04;
		text-wrap: balance;
	}
	.hero-copy > p:last-child {
		max-width: 32rem;
		margin: 0;
		color: var(--text-muted);
		font-size: clamp(0.98rem, 2vw, 1.08rem);
		line-height: 1.55;
		text-wrap: balance;
	}
	.hero-action {
		justify-self: start;
		align-self: end;
		display: inline-flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.9rem 1.2rem;
		text-decoration: none;
	}
	.today-grid {
		display: grid;
		gap: var(--gap);
	}
	.state-stack {
		display: grid;
		gap: var(--gap);
	}
	.continue-card,
	.garden-card,
	.activity-card {
		max-width: none;
	}
	.section-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}
	.section-head h2 {
		margin: 0;
		font-size: 1.45rem;
	}
	.section-head > a {
		flex: 0 0 auto;
		padding-top: 0.3rem;
		color: var(--primary-strong);
		font-size: 0.8rem;
		font-weight: 700;
		text-decoration: none;
	}
	.section-head > a:hover {
		text-decoration: underline;
	}
	.continue-list {
		display: flex;
		flex-direction: column;
	}
	.continue-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.8rem;
		padding: 0.9rem 0;
		color: var(--text);
		text-decoration: none;
	}
	.continue-row + .continue-row {
		border-top: 1px solid var(--border);
	}
	.continue-row:hover .continue-copy strong {
		color: var(--primary-strong);
	}
	.continue-mark {
		display: grid;
		place-items: center;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius);
		background: var(--primary-soft);
		color: var(--primary-strong);
	}
	.continue-copy {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.15rem;
	}
	.continue-copy strong {
		overflow: hidden;
		font-family: var(--font-display);
		font-size: 1.05rem;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: color 0.15s ease;
	}
	.continue-copy small {
		color: var(--text-muted);
	}
	.row-arrow {
		width: 1rem;
		height: 1rem;
		color: var(--text-muted);
	}
	.garden-total {
		display: flex;
		align-items: baseline;
		gap: 0.4rem;
		margin: 0.25rem 0 1rem;
		font-family: var(--font-display);
		font-size: 2.5rem;
		font-weight: 750;
		line-height: 1;
	}
	.garden-total span {
		color: var(--text-muted);
		font-family: var(--font);
		font-size: 0.75rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.beds {
		display: flex;
		gap: 3px;
		height: 0.65rem;
		overflow: hidden;
		border-radius: 999px;
		background: var(--surface-alt);
	}
	.bed {
		min-width: 0.3rem;
	}
	.bed-new {
		background: var(--amber);
	}
	.bed-young {
		background: var(--primary);
	}
	.bed-solid {
		background: var(--primary-strong);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1rem;
		margin: 0.85rem 0 0;
		padding: 0;
		color: var(--text-muted);
		font-size: 0.75rem;
		list-style: none;
	}
	.legend li {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.legend strong {
		color: var(--text);
	}
	.dot {
		width: 0.48rem;
		height: 0.48rem;
		border-radius: 50%;
	}
	.strip {
		display: flex;
		height: 6rem;
		gap: 0.35rem;
	}
	.strip-col {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		align-items: center;
		gap: 0.35rem;
		color: var(--text-muted);
		font-size: 0.68rem;
		font-weight: 700;
	}
	.strip-col.today {
		color: var(--primary-strong);
	}
	.strip-track {
		display: flex;
		width: 100%;
		flex: 1;
		align-items: flex-end;
		justify-content: center;
		overflow: hidden;
		border-radius: 4px 4px 2px 2px;
		background: color-mix(in srgb, var(--surface-alt) 60%, transparent);
	}
	.strip-bar {
		width: 100%;
		border-radius: 4px 4px 2px 2px;
		background: var(--primary);
	}
	.strip-col.today .strip-bar {
		background: var(--accent);
	}
	.activity-note {
		margin: 0.75rem 0 0;
		color: var(--text-muted);
		font-size: 0.8rem;
	}
	.error {
		margin: 0;
		color: var(--danger);
		font-weight: 700;
	}
	@media (min-width: 48rem) {
		.shell {
			padding-block: 3rem 5rem;
		}
		.hero {
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: end;
			min-height: 22rem;
		}
		.hero-action {
			justify-self: end;
		}
		.today-grid {
			grid-template-columns: minmax(0, 3fr) minmax(18rem, 2fr);
			align-items: start;
		}
		.today-grid.without-continue {
			grid-template-columns: 1fr;
		}
		.today-grid.without-continue .state-stack {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 30rem) {
		.today-header {
			align-items: stretch;
			flex-direction: column;
		}
		.header-tools {
			justify-content: space-between;
		}
		.hero {
			min-height: 23rem;
		}
		.hero-sprout {
			right: -2rem;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.continue-copy strong {
			transition: none;
		}
	}
</style>
