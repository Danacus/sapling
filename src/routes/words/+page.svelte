<!--
  The word ledger: every word the learner owns, with the scheduler's own
  numbers on the page.

  The dashboard shows a weakest-first preview and nothing else, which is the
  right amount of detail for a home screen and the wrong amount for the
  question this page answers: *why* is this word due today and that one not.
  So everything FSRS tracks is visible here — stability, difficulty, recall
  chance, reps, lapses, the whole review log — plus a glossary that says what
  those words actually mean. Transparency is the feature; nothing is
  summarized away.

  The one write is forgetting a word, and it lives at the bottom of an opened
  detail behind its own confirm step: destructive with no undo, so it must
  never be one mis-tap from a row opened out of curiosity.

  All derivation goes through `$lib/words/view` — this file only decides how
  the numbers look, never what they are.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';

	import { deleteItem, getAllItems, getProfile } from '$lib/db';
	import { hideReadingProbability } from '$lib/session/romanization';
	import { CardState } from '$lib/srs';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import ProgressBar from '$lib/ui/ProgressBar.svelte';
	import { getRomanizationMode } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import {
		formatDays,
		formatRelative,
		filterWords,
		STATE_LABELS,
		toWordRow,
		type SortDir,
		type SortKey,
		type StateFilter,
		type WordRow
	} from '$lib/words/view';

	/**
	 * How many history ticks a row draws before it says "and N earlier".
	 *
	 * Matches `RECENT_GRADES_CAP` in `$lib/db/schema`: the store keeps exactly
	 * this many per item so the ledger never has to read the review rows.
	 */
	const HISTORY_CAP = 40;

	/**
	 * The tick strip reads the stored aggregates, so this page asks `getAllItems`
	 * for `recentGrades` explicitly — the one caller that draws them. The
	 * `history` fallback covers items built in memory.
	 */
	const reviewsOf = (item: KnowledgeItem) => item.reviewCount ?? item.history.length;
	const ticksOf = (item: KnowledgeItem) => item.recentGrades ?? item.history;

	/** Sort keys in the order they read best in the menu, not registry order. */
	const SORT_OPTIONS: { value: SortKey; label: string }[] = [
		{ value: 'due', label: 'Due date' },
		{ value: 'strength', label: 'Strength' },
		{ value: 'retrievability', label: 'Recall chance' },
		{ value: 'stability', label: 'Stability' },
		{ value: 'difficulty', label: 'Difficulty' },
		{ value: 'reps', label: 'Reviews' },
		{ value: 'lapses', label: 'Lapses' },
		{ value: 'accuracy', label: 'Accuracy' },
		{ value: 'introduced', label: 'First seen' },
		{ value: 'alpha', label: 'Alphabetical' }
	];

	const STATE_ORDER: CardState[] = [
		CardState.New,
		CardState.Learning,
		CardState.Review,
		CardState.Relearning
	];

	/** ts-fsrs `Rating` names, for the review-history tooltips. */
	const GRADE_LABELS: Record<number, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

	/** Read once — the setting lives in Settings, not mid-page. */
	const romanizationMode = getRomanizationMode();

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	/** Captured once at load, so every relative time on the page agrees. */
	let now = $state(Date.now());

	// The query. Due-ascending is the default because it is the view that
	// explains the app: most overdue first, which is exactly the order a
	// session would draw them in.
	let search = $state('');
	let sort = $state<SortKey>('due');
	let dir = $state<SortDir>('asc');
	let filter = $state<StateFilter>('all');

	/**
	 * Ids of the rows opened out. Several at once: comparing two words is the
	 * point — but never two from the same visual row of the ledger, see
	 * {@link onePerRow}.
	 */
	let opened = $state<string[]>([]);

	/**
	 * How many entries share a visual row of the ledger: 1 on a phone, 2 from
	 * 48rem, 3 from 72rem — the same steps as the `.ledger` grid below. An
	 * opened note is a band under its *whole* row, so two notes under one row
	 * stack with nothing to say which word each belongs to. A row therefore
	 * holds one open word at a time; on a phone every entry is its own row and
	 * the rule never binds.
	 */
	let columns = $state(1);

	$effect(() => {
		if (!browser) return;
		const wide = window.matchMedia('(min-width: 48rem)');
		const broad = window.matchMedia('(min-width: 72rem)');
		const update = () => {
			columns = broad.matches ? 3 : wide.matches ? 2 : 1;
		};
		update();
		wide.addEventListener('change', update);
		broad.addEventListener('change', update);
		return () => {
			wide.removeEventListener('change', update);
			broad.removeEventListener('change', update);
		};
	});

	/**
	 * The forget flow, armed per row: the first tap swaps the quiet button for
	 * an explicit confirm pair, and closing the row disarms it. There is no
	 * undo, so one mis-tap must never be enough — but a browser `confirm()`
	 * would be the only native dialog in the app, so the second step lives on
	 * the page instead.
	 */
	let confirming = $state<string | null>(null);
	let forgetError = $state<{ id: string; message: string } | null>(null);

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems({ withRecentGrades: true })])
			.then(([loadedProfile, loadedItems]) => {
				if (cancelled) return;
				profile = loadedProfile;
				items = loadedItems;
				now = Date.now();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your words.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/** The real language name, for speech — never the display fallback. */
	const speechLanguage = $derived(profile?.targetLanguage?.trim() ?? '');

	/** Every word, unfiltered: what the summary tiles count. */
	const allRows = $derived(items.map((item) => toWordRow(item, now)));

	const dueCount = $derived(allRows.filter((row) => row.due).length);

	const stateCounts = $derived(
		STATE_ORDER.map((state) => ({
			state,
			count: allRows.filter((row) => row.state === state).length
		}))
	);

	/** The one place filtering, searching and sorting happen. */
	const rows = $derived(filterWords(allRows, { search, sort, dir, filter }));

	const filtered = $derived(search.trim() !== '' || filter !== 'all');

	/**
	 * Whether a word shows its reading, matching the dashboard exactly: adaptive
	 * mode hides only what the learner fully owns, and never rolls a coin on a
	 * static list where a reading that came and went would read as a bug.
	 */
	function showsReading(strength: number): boolean {
		if (romanizationMode === 'on') return true;
		if (romanizationMode === 'off') return false;
		return hideReadingProbability(strength) < 1;
	}

	/**
	 * Red below 0.5, amber below 0.85, green above — the dashboard's thresholds,
	 * roughly "under 5 days of stability", "under 18 days", and "mature".
	 */
	function strengthColor(strength: number): string {
		if (strength < 0.5) return 'var(--danger)';
		if (strength < 0.85) return 'var(--amber)';
		return 'var(--primary)';
	}

	function pct(fraction: number): string {
		return `${Math.round(fraction * 100)}%`;
	}

	function formatAbsolute(ts: number): string {
		return new Date(ts).toLocaleDateString(undefined, {
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		});
	}

	/**
	 * "in 3 d" ahead of time, "2 h overdue" behind it. FSRS' own word for a card
	 * past its due date is *due*, not *late* — this is not a scolding, it is the
	 * queue depth, which is why overdue words are tinted and not flagged.
	 */
	function dueText(row: WordRow): string {
		if (row.card.due > now) return formatRelative(row.card.due, now);
		const relative = formatRelative(row.card.due, now);
		return relative === 'just now' ? 'due now' : relative.replace(/ ago$/, ' overdue');
	}

	/** The collapsed row's right-hand readout: whatever the active sort ranks by. */
	function statText(row: WordRow): string {
		switch (sort) {
			case 'due':
				return dueText(row);
			case 'retrievability':
				return pct(row.retrievability);
			case 'stability':
				return formatDays(row.card.stability);
			case 'difficulty':
				return row.card.difficulty.toFixed(1);
			case 'reps':
				return `${row.card.reps}`;
			case 'lapses':
				return `${row.card.lapses}`;
			case 'accuracy':
				return row.accuracy === null ? '—' : pct(row.accuracy);
			case 'introduced':
				return formatRelative(row.item.introducedAt, now);
			case 'strength':
			case 'alpha':
				// Both fall back to the strength bar, which is drawn instead of text.
				return '';
		}
	}

	/** Alphabetical has no number of its own, so it borrows the strength bar. */
	const showsBar = $derived(sort === 'strength' || sort === 'alpha');

	function tagClass(state: CardState): string {
		switch (state) {
			case CardState.New:
				return 'tag-new';
			case CardState.Learning:
				return 'tag-learning';
			case CardState.Review:
				return 'tag-review';
			case CardState.Relearning:
				return 'tag-relearning';
		}
	}

	function gradeColor(grade: number): string {
		if (grade <= 1) return 'var(--danger)';
		if (grade === 2) return 'var(--amber)';
		if (grade === 3) return 'var(--primary)';
		return 'var(--primary-strong)';
	}

	function isOpen(id: string): boolean {
		return opened.includes(id);
	}

	/**
	 * Which visual row of the ledger a word sits in, or -1 when the current
	 * filter hides it. The grid's dense backfill keeps every entry in the row
	 * its index says, however many notes are open above it.
	 */
	function rowOf(id: string): number {
		const index = rows.findIndex((row) => row.item.id === id);
		return index < 0 ? -1 : Math.floor(index / columns);
	}

	/**
	 * The open set with at most one word per visual row, earliest opened
	 * winning. A hidden word (row -1) is left alone: it comes back with the
	 * filter that hid it, as it always did.
	 */
	function onePerRow(ids: string[]): string[] {
		const taken = new Set<number>();
		return ids.filter((id) => {
			const row = rowOf(id);
			if (row < 0) return true;
			if (taken.has(row)) return false;
			taken.add(row);
			return true;
		});
	}

	function close(id: string): void {
		opened = opened.filter((candidate) => candidate !== id);
		if (confirming === id) confirming = null;
		if (forgetError?.id === id) forgetError = null;
	}

	function toggle(id: string): void {
		if (isOpen(id)) {
			close(id);
			return;
		}
		// The word just tapped wins its row: its neighbour folds away first.
		const row = rowOf(id);
		for (const other of opened) if (rowOf(other) === row) close(other);
		opened = [...opened, id];
	}

	// A re-sort, a filter or a resize can land two open words on one row.
	// `opened` is read untracked: the effect answers to the layout changing,
	// not to `toggle`, which already keeps the rule on its own.
	$effect(() => {
		void rows;
		void columns;
		untrack(() => {
			const kept = onePerRow(opened);
			for (const id of opened) if (!kept.includes(id)) close(id);
		});
	});

	/**
	 * Forgets a word for good — its meaning, its history and its SRS card. The
	 * only way back is to meet it again in a future lesson, as a brand-new item.
	 * Queued challenges that referenced it stay playable and simply grade
	 * nothing (see `applyResult`), so nothing has to be swept.
	 */
	async function removeItem(row: WordRow): Promise<void> {
		const id = row.item.id;
		try {
			await deleteItem(id);
			// `rows` and the summary counts are derived from `items`, so one
			// filter updates the whole page.
			items = items.filter((candidate) => candidate.id !== id);
			opened = opened.filter((candidate) => candidate !== id);
			confirming = null;
			forgetError = null;
		} catch (cause) {
			forgetError = {
				id,
				message: cause instanceof Error ? cause.message : 'Could not delete that word.'
			};
		}
	}

	function clearFilters(): void {
		search = '';
		filter = 'all';
	}
</script>

<svelte:head>
	<title>Garden</title>
</svelte:head>

<main class="shell shell-full">
	<header class="topbar ll-rise">
		<a class="back" href="/" aria-label="Back to home">
			<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
				<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
			</svg>
		</a>
		<div class="identity">
			<p class="eyebrow">Sapling</p>
			<h1>Garden</h1>
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
	{:else if items.length === 0}
		<section class="card empty-card ll-rise" style="animation-delay: 60ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.8 5.2v13.6" />
					<path d="M8.2 7.6h11M8.2 12h11M8.2 16.4h7.4" />
				</svg>
				<h2>Nothing entered yet</h2>
			</div>
			<hr class="stitch" />
			<p class="hint">
				Every word you meet grows here — when it is next due, how firmly it has settled, and every
				review you have ever given it. Your first session writes the first entry.
			</p>
			<a class="btn btn-primary btn-block" href="/learn">Start a session</a>
		</section>
	{:else}
		<!--
		  The summary strip is also the filter: six counts that add up to the
		  collection, each one a way into it. A separate row of filter chips
		  under a row of stat tiles would have said the same thing twice.
		-->
		<div
			class="summary ll-rise"
			style="animation-delay: 60ms"
			role="group"
			aria-label="Filter words"
		>
			<button
				type="button"
				class="tile"
				class:active={filter === 'all'}
				aria-pressed={filter === 'all'}
				onclick={() => (filter = 'all')}
			>
				<span class="tile-num">{allRows.length}</span>
				<span class="tile-label">Words</span>
			</button>
			<button
				type="button"
				class="tile"
				class:active={filter === 'due'}
				aria-pressed={filter === 'due'}
				onclick={() => (filter = 'due')}
			>
				<span class="tile-num" class:accented={dueCount > 0}>{dueCount}</span>
				<span class="tile-label">Due now</span>
			</button>
			{#each stateCounts as entry (entry.state)}
				<button
					type="button"
					class="tile"
					class:active={filter === entry.state}
					aria-pressed={filter === entry.state}
					onclick={() => (filter = entry.state)}
				>
					<span class="tile-num">{entry.count}</span>
					<span class="tile-label">{STATE_LABELS[entry.state]}</span>
				</button>
			{/each}
		</div>

		<section class="card ledger-card ll-rise" style="animation-delay: 120ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.8 5.2v13.6" />
					<path d="M8.2 7.6h11M8.2 12h11M8.2 16.4h7.4" />
				</svg>
				<h2>Entries</h2>
				<span class="entry-count">
					{#if filtered}{rows.length} of {allRows.length}{:else}{allRows.length} words{/if}
				</span>
			</div>
			<hr class="stitch" />

			<div class="controls">
				<div class="search">
					<svg class="ico search-ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="11" cy="10.8" r="5.8" />
						<path d="m15.4 15.2 4 4.2" />
					</svg>
					<input
						id="word-search"
						class="input"
						type="search"
						autocomplete="off"
						bind:value={search}
						aria-label="Search your words"
						placeholder="Search term, meaning, reading…"
					/>
					{#if search !== ''}
						<button
							type="button"
							class="clear"
							aria-label="Clear search"
							onclick={() => (search = '')}
						>
							<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
								<path d="m7 7 10 10M17 7 7 17" />
							</svg>
						</button>
					{/if}
				</div>

				<div class="sort">
					<label class="sort-label" for="word-sort">Sort</label>
					<select id="word-sort" class="input" bind:value={sort}>
						{#each SORT_OPTIONS as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
					<button
						type="button"
						class="dir"
						class:desc={dir === 'desc'}
						aria-pressed={dir === 'desc'}
						aria-label="Sort descending"
						title={dir === 'asc' ? 'Ascending — smallest first' : 'Descending — largest first'}
						onclick={() => (dir = dir === 'asc' ? 'desc' : 'asc')}
					>
						<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M12 4.6v14.8" />
							<path d="m6.6 10 5.4-5.4 5.4 5.4" />
						</svg>
					</button>
				</div>
			</div>

			{#if rows.length === 0}
				<p class="nothing">
					Nothing matches.
					<button type="button" class="btn btn-ghost clear-filters" onclick={clearFilters}>
						Clear search and filters
					</button>
				</p>
			{:else}
				<ul class="ledger">
					{#each rows as row (row.item.id)}
						{@const open = isOpen(row.item.id)}
						<li class="row" class:open>
							<div class="entry">
								<button
									type="button"
									class="entry-main"
									aria-expanded={open}
									aria-controls={`detail-${row.item.id}`}
									onclick={() => toggle(row.item.id)}
								>
									<svg class="ico caret" class:turned={open} viewBox="0 0 24 24" aria-hidden="true">
										<path d="m9.6 5.8 6.4 6.2-6.4 6.2" />
									</svg>
									<span class="word-text">
										<span class="term">{row.item.term}</span>
										{#if showsReading(row.strength) && row.item.romanization}
											<span class="rom">{row.item.romanization}</span>
										{/if}
										<span class="meaning">{row.item.meaning}</span>
									</span>
									<span class="readout">
										{#if showsBar}
											<span class="mini-bar">
												<ProgressBar
													value={row.strength}
													color={strengthColor(row.strength)}
													label={`Recall strength for ${row.item.term}`}
												/>
											</span>
										{:else}
											<span class="stat" class:overdue={sort === 'due' && row.due}>
												{statText(row)}
											</span>
										{/if}
										<span class="tag {tagClass(row.state)}">{STATE_LABELS[row.state]}</span>
									</span>
								</button>
								<SpeakButton text={row.item.term} lang={speechLanguage} size="sm" />
							</div>

							{#if open}
								<!--
								  Pinned into the margin like a note added later: the dashed
								  rule is the same one the cards use, turned on its side —
								  and closed into a full frame once the ledger is a grid.
								-->
								<div class="detail ll-rise" id={`detail-${row.item.id}`}>
									<dl class="facts">
										<div class="fact">
											<dt>State</dt>
											<dd>{STATE_LABELS[row.state]}</dd>
										</div>
										<div class="fact">
											<dt>Due</dt>
											<dd class:overdue={row.due}>{dueText(row)}</dd>
											<p class="sub">{formatAbsolute(row.card.due)}</p>
										</div>
										<div class="fact">
											<dt>Stability</dt>
											<dd>{formatDays(row.card.stability)}</dd>
										</div>
										<div class="fact">
											<dt>Difficulty</dt>
											<dd>{row.card.difficulty.toFixed(1)}<span class="of">/10</span></dd>
										</div>
										<div class="fact">
											<dt>Recall chance</dt>
											<dd>{pct(row.retrievability)}</dd>
										</div>
										<div class="fact">
											<dt>Interval</dt>
											<dd>{formatDays(row.card.scheduled_days)}</dd>
										</div>
										<div class="fact">
											<dt>Reviews</dt>
											<dd>{row.card.reps}</dd>
										</div>
										<div class="fact">
											<dt>Lapses</dt>
											<dd>{row.card.lapses}</dd>
										</div>
										<div class="fact">
											<dt>Accuracy</dt>
											<dd>{row.accuracy === null ? '—' : pct(row.accuracy)}</dd>
										</div>
										<div class="fact">
											<dt>First seen</dt>
											<dd>{formatRelative(row.item.introducedAt, now)}</dd>
											<p class="sub">{formatAbsolute(row.item.introducedAt)}</p>
										</div>
										<div class="fact">
											<dt>Last review</dt>
											<dd>
												{row.lastReviewAt === null
													? 'Never'
													: formatRelative(row.lastReviewAt, now)}
											</dd>
											{#if row.lastReviewAt !== null}
												<p class="sub">{formatAbsolute(row.lastReviewAt)}</p>
											{/if}
										</div>
									</dl>

									<div class="strength-block">
										<div class="strength-line">
											<span class="strength-label">Strength</span>
											<span class="strength-value">{pct(row.strength)}</span>
										</div>
										<ProgressBar
											value={row.strength}
											color={strengthColor(row.strength)}
											label={`Recall strength for ${row.item.term}`}
										/>
									</div>

									{#if row.item.notes}
										<p class="notes">{row.item.notes}</p>
									{/if}

									<div class="history">
										<span class="history-label">Review history</span>
										{#if reviewsOf(row.item) === 0}
											<p class="sub none">
												No reviews yet — this word is still waiting for its first.
											</p>
										{:else}
											{@const shown = ticksOf(row.item).slice(-HISTORY_CAP)}
											{@const earlier = reviewsOf(row.item) - shown.length}
											<div class="ticks">
												{#each shown as entry, index (`${entry.at}-${index}`)}
													<span
														class="tick"
														style={`background: ${gradeColor(entry.grade)};`}
														title={`${GRADE_LABELS[entry.grade] ?? 'Graded'} · ${formatAbsolute(entry.at)}`}
													></span>
												{/each}
											</div>
											<p class="sub">
												Oldest to newest{earlier > 0 ? ` · ${earlier} earlier not shown` : ''}
											</p>
										{/if}
									</div>

									<div class="forget-block">
										{#if confirming === row.item.id}
											<p class="forget-warning">
												Forgetting “{row.item.term}” removes its progress and review history. There
												is no undo.
											</p>
											<div class="forget-actions">
												<button
													type="button"
													class="btn forget-confirm"
													onclick={() => void removeItem(row)}
												>
													Forget for good
												</button>
												<button
													type="button"
													class="btn btn-ghost"
													onclick={() => (confirming = null)}
												>
													Keep it
												</button>
											</div>
										{:else}
											<button
												type="button"
												class="btn btn-ghost forget-arm"
												onclick={() => (confirming = row.item.id)}
											>
												<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
													<path d="M5.4 7h13.2" />
													<path d="M9.2 7V5.2h5.6V7" />
													<path d="m7 7 .8 12h8.4L17 7" />
												</svg>
												Forget this word
											</button>
										{/if}
										{#if forgetError?.id === row.item.id}
											<p class="error forget-error" role="alert">{forgetError.message}</p>
										{/if}
									</div>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<!--
		  The numbers above are only transparent if the learner knows what they
		  mean. Closed by default: it is a footnote, not a lecture.
		-->
		<details class="card glossary ll-rise" style="animation-delay: 180ms">
			<summary>
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="8.2" />
					<path d="M9.8 9.6a2.3 2.3 0 1 1 2.9 2.5v1.4" />
					<path d="M12.7 16.6h.01" />
				</svg>
				<h2>How to read this page</h2>
				<svg class="ico caret summary-caret" viewBox="0 0 24 24" aria-hidden="true">
					<path d="m9.6 5.8 6.4 6.2-6.4 6.2" />
				</svg>
			</summary>
			<hr class="stitch" />
			<dl class="glossary-list">
				<div class="entry-def">
					<dt>Stability</dt>
					<dd>
						How long the word holds. Measured in days: the time it takes your chance of recalling it
						to drift down to about 90%. Every review you get right after a real gap stretches it.
					</dd>
				</div>
				<div class="entry-def">
					<dt>Difficulty</dt>
					<dd>
						How stubborn the scheduler thinks <em>this word</em> is, on a 1–10 scale. It creeps up when
						you forget it and eases down when you find it easy. It is a property of the word, not a mark
						against you.
					</dd>
				</div>
				<div class="entry-def">
					<dt>Recall chance</dt>
					<dd>
						The estimated probability you would get the word right if it were asked this second. It
						falls as time passes and resets with each review — reviews are scheduled to land while
						it is still around 90%, so words you are on top of sit high.
					</dd>
				</div>
				<div class="entry-def">
					<dt>Strength</dt>
					<dd>
						The dashboard's bar: how mature the word is (stability, on a log scale where 30 days
						counts as fully grown) multiplied by its recall chance right now. Recall chance alone
						would read full for everyone on schedule; multiplying is what makes a mature word left
						untouched for a month visibly sag.
					</dd>
				</div>
				<div class="entry-def">
					<dt>New · Learning · Review · Relearning</dt>
					<dd>
						The word's place in the schedule. <strong>New</strong> is waiting for its first outing;
						<strong>Learning</strong> is finding its feet over minutes and days;
						<strong>Review</strong> is on a long interval; <strong>Relearning</strong> is a word that
						had settled, came back wrong, and is being rebuilt.
					</dd>
				</div>
				<div class="entry-def">
					<dt>Lapses</dt>
					<dd>
						How many times a word you had already learned came back wrong. Each lapse shortens the
						next interval and nudges the word's difficulty up — which is the system working, not you
						failing.
					</dd>
				</div>
			</dl>
		</details>
	{/if}
</main>

<style>
	/*
	  This page is a list of many small, independent entries — exactly what
	  `.shell-full` is for: on a wide screen the win is more columns, not a
	  wider line, so horizontal width is left entirely to the global `.shell` +
	  `.shell-full` rules. Only the vertical rhythm (top/bottom padding, the
	  column flex, the gap between sections) is this route's own concern.
	*/
	.shell {
		padding-block: 2rem 4rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	/* The same hand as every other screen: 24-unit box, hairline stroke, round
	   joins. */
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
		align-items: center;
		gap: 0.75rem;
	}

	.back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.back:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.back:focus-visible {
		outline: none;
		box-shadow: var(--ring);
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

	/* Only the two cards that hold many small things take the full shell. The
	   load-error and empty-garden cards are one sentence each and keep the
	   reading measure: a sentence has no use for 78rem. */
	.ledger-card,
	.glossary {
		max-width: none;
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.card-head h2 {
		margin: 0;
		font-size: 1.08rem;
	}

	.head-ico {
		width: 1.85rem;
		height: 1.85rem;
		padding: 0.3rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--primary-soft) 60%, transparent);
		color: var(--primary-strong);
	}

	.card-head + .stitch {
		margin: 0.85rem 0 1.15rem;
	}

	.entry-count {
		margin-left: auto;
		font-size: 0.78rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
	}

	.empty-card .btn {
		margin-top: 0.5rem;
	}

	/* Summary strip ---------------------------------------------------------- */

	/* Specimen tickets laid straight on the paper rather than inside a card:
	   they are a control, and a control in a card reads as content. */
	.summary {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(5rem, 1fr));
		gap: 0.5rem;
	}

	.tile {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.05rem;
		padding: 0.55rem 0.6rem;
		border: 1px solid var(--border);
		border-bottom-width: 3px;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			transform 0.08s ease;
	}

	.tile:hover {
		border-color: var(--border-strong);
	}

	.tile:active {
		transform: translateY(1px);
		border-bottom-width: 1px;
	}

	.tile.active {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.tile:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.tile-num {
		font-family: var(--font-display);
		font-size: 1.3rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	/* Work waiting for you gets the terracotta, whether or not the tile is the
	   active filter — the count is the point, not the selection. */
	.tile-num.accented {
		color: color-mix(in srgb, var(--accent) 75%, var(--text));
	}

	.tile-label {
		font-size: 0.63rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* Controls --------------------------------------------------------------- */

	.controls {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin-bottom: 0.9rem;
	}

	.search {
		position: relative;
	}

	.search .input {
		padding-left: 2.3rem;
		padding-right: 2.3rem;
	}

	/* Type=search draws its own clear button in some engines; ours is the one
	   that matches the page. */
	.search .input::-webkit-search-cancel-button {
		display: none;
	}

	.search-ico {
		position: absolute;
		left: 0.75rem;
		top: 50%;
		transform: translateY(-50%);
		color: var(--text-muted);
		pointer-events: none;
	}

	.clear {
		position: absolute;
		right: 0.45rem;
		top: 50%;
		transform: translateY(-50%);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.7rem;
		height: 1.7rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.clear .ico {
		width: 0.85rem;
		height: 0.85rem;
		stroke-width: 1.9;
	}

	.clear:hover {
		border-color: var(--border);
		background: var(--surface-alt);
		color: var(--text);
	}

	.clear:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.sort {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sort-label {
		flex: 0 0 auto;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* Native select keeps the `.input` frame; only the marker is ours — two
	   gradient halves, so the caret follows the ink colour in either theme. */
	select.input {
		flex: 1 1 auto;
		min-width: 0;
		appearance: none;
		padding: 0.55rem 2.2rem 0.55rem 0.7rem;
		font-size: 0.92rem;
		font-weight: 600;
		background-image:
			linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
			linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
		background-position:
			right 1.15rem center,
			right 0.85rem center;
		background-size: 0.32rem 0.32rem;
		background-repeat: no-repeat;
	}

	/* The arrow points up for ascending and flips over for descending — the
	   only rotation on the page that carries meaning. */
	.dir {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2.35rem;
		height: 2.35rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.dir:hover {
		background: var(--surface-alt);
		color: var(--text);
	}

	.dir .ico {
		transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.3, 1);
	}

	.dir.desc .ico {
		transform: rotate(180deg);
	}

	.dir.desc {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.dir:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* The ledger ------------------------------------------------------------- */

	.ledger {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row + .row {
		border-top: 1px solid var(--border);
	}

	/* An opened entry tints its whole strip, so a page of rows still reads as a
	   page when three of them are unfolded. */
	.row.open {
		background: color-mix(in srgb, var(--surface-alt) 45%, transparent);
	}

	.entry {
		display: flex;
		align-items: center;
		gap: 0.15rem;
	}

	/* The speaker is a sibling of the disclosure button, never inside it: a
	   button in a button is invalid, and clicking one would fire both. */
	.entry-main {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		grid-template-columns: 0.85rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 0.25rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.entry-main:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.caret {
		width: 0.85rem;
		height: 0.85rem;
		color: var(--text-muted);
		transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.3, 1);
	}

	.entry-main:hover .caret {
		color: var(--accent);
	}

	.caret.turned {
		transform: rotate(90deg);
	}

	.word-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.term {
		font-weight: 700;
		letter-spacing: -0.005em;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.word-text :global(.rom) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meaning {
		font-size: 0.85rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.readout {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.2rem;
	}

	.stat {
		font-size: 0.85rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.stat.overdue,
	dd.overdue {
		color: color-mix(in srgb, var(--danger) 70%, var(--text));
	}

	.mini-bar {
		display: block;
		width: 3.6rem;
	}

	/* State tags. Each hue is mixed toward the ink for the text so the label
	   keeps its contrast in both themes, and stays raw for the frame and wash. */
	.tag {
		display: inline-block;
		padding: 0.02rem 0.4rem;
		border: 1px solid;
		border-radius: 999px;
		font-size: 0.63rem;
		font-weight: 700;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.tag-new {
		border-color: color-mix(in srgb, var(--accent) 40%, transparent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: color-mix(in srgb, var(--accent) 62%, var(--text));
	}

	.tag-learning {
		border-color: color-mix(in srgb, var(--amber) 45%, transparent);
		background: color-mix(in srgb, var(--amber) 12%, transparent);
		color: color-mix(in srgb, var(--amber) 55%, var(--text));
	}

	.tag-review {
		border-color: color-mix(in srgb, var(--primary) 40%, transparent);
		background: color-mix(in srgb, var(--primary) 10%, transparent);
		color: color-mix(in srgb, var(--primary) 62%, var(--text));
	}

	.tag-relearning {
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		color: color-mix(in srgb, var(--danger) 62%, var(--text));
	}

	/* Expanded detail -------------------------------------------------------- */

	.detail {
		margin: 0 0 0.9rem 0.55rem;
		padding-left: 0.9rem;
		border-left: 1px dashed var(--border-strong);
	}

	.facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.7rem 1rem;
		margin: 0;
	}

	.fact {
		min-width: 0;
	}

	.fact dt {
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.fact dd {
		margin: 0.1rem 0 0;
		font-size: 0.95rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.of {
		font-weight: 500;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.sub {
		margin: 0.1rem 0 0;
		font-size: 0.74rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.sub.none {
		font-size: 0.82rem;
	}

	.strength-block {
		margin-top: 1rem;
	}

	.strength-line {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.3rem;
	}

	.strength-label {
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.strength-value {
		font-size: 0.85rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.notes {
		margin: 1rem 0 0;
		padding: 0.55rem 0.7rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
		font-size: 0.88rem;
	}

	.history {
		margin-top: 1rem;
	}

	.history-label {
		display: block;
		margin-bottom: 0.35rem;
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* One tally mark per review, oldest at the left — the margin of a notebook
	   where you keep score. Wraps rather than scrolls: a long history should
	   grow downwards like everything else on the page. */
	.ticks {
		display: flex;
		flex-wrap: wrap;
		gap: 3px;
	}

	.tick {
		width: 4px;
		height: 1.05rem;
		border-radius: 1px;
		opacity: 0.85;
	}

	/* Forgetting ------------------------------------------------------------- */

	/* Set off below its own hairline: destruction lives at the bottom of the
	   note, not among the facts. */
	.forget-block {
		margin-top: 1rem;
		padding-top: 0.75rem;
		border-top: 1px dashed var(--border);
	}

	.forget-arm {
		padding: 0.4rem 0.8rem;
		font-size: 0.83rem;
	}

	.forget-arm .ico {
		width: 1rem;
		height: 1rem;
	}

	.forget-arm:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		color: var(--danger);
	}

	.forget-warning {
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--danger);
	}

	.forget-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.forget-actions .btn {
		padding: 0.45rem 0.9rem;
		font-size: 0.83rem;
	}

	/* The danger twin of .btn-primary, pressed edge and all. */
	.forget-confirm {
		background: var(--danger);
		color: var(--text-inverse);
		box-shadow: 0 3px 0 color-mix(in srgb, var(--danger) 70%, black);
	}

	.forget-confirm:hover:not(:disabled) {
		filter: brightness(1.04);
	}

	.forget-confirm:active:not(:disabled) {
		box-shadow: 0 1px 0 color-mix(in srgb, var(--danger) 70%, black);
	}

	.forget-error {
		margin-top: 0.6rem;
		font-size: 0.85rem;
	}

	/* Empty results ---------------------------------------------------------- */

	.nothing {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin: 0.4rem 0 0.2rem;
		color: var(--text-muted);
	}

	.clear-filters {
		padding: 0.28rem 0.7rem;
		border-color: var(--border);
		font-size: 0.78rem;
	}

	/* Glossary --------------------------------------------------------------- */

	.glossary summary {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		list-style: none;
		cursor: pointer;
	}

	.glossary summary::-webkit-details-marker {
		display: none;
	}

	.glossary summary h2 {
		margin: 0;
		font-size: 1.08rem;
	}

	.glossary summary:focus-visible {
		outline: none;
		box-shadow: var(--ring);
		border-radius: var(--radius-sm);
	}

	.summary-caret {
		margin-left: auto;
		color: var(--text-muted);
		transition: transform 0.18s cubic-bezier(0.2, 0.7, 0.3, 1);
	}

	.glossary[open] .summary-caret {
		transform: rotate(90deg);
	}

	.glossary-list {
		margin: 0;
	}

	.entry-def + .entry-def {
		margin-top: 0.9rem;
	}

	.entry-def dt {
		font-family: var(--font-display);
		font-size: 0.98rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
	}

	.entry-def dd {
		margin: 0.15rem 0 0;
		font-size: 0.9rem;
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

	/* Wide layout: the ledger becomes a grid --------------------------------- */

	/*
	  48rem buys room for two entries side by side. Explicit column counts
	  rather than `auto-fill`/minmax: the point is a steady count pegged to the
	  two breakpoints, not however many ~18rem cells happen to fit at whatever
	  width the window is in between — a table that quietly gains a column at
	  900px and loses it again at 850px would read as a bug. The script's
	  `columns` mirrors these same steps, so it knows which entries share a row.

	  Opening a word must not move the words beside it. So the `<li>` stops
	  generating a box (`display: contents`) and its two children become the
	  grid items in its place: the entry keeps its own single cell, and the
	  detail is a separate full-span item. `dense` does the rest — the detail
	  cannot fit alongside its entry, so it falls to the next row, and the
	  entries after it backfill the cells left empty in the row above. A B C
	  stay where they were, the note opens underneath all three, D E F resume
	  below it.

	  With no box left on the `<li>`, the card frame and the opened tint move
	  onto `.entry` — the plain top hairline of the stacked list says nothing
	  about entries sitting side by side.
	*/
	@media (min-width: 48rem) {
		.ledger {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			grid-auto-flow: dense;
			gap: var(--gap);
		}

		.row {
			display: contents;
		}

		.entry {
			position: relative;
			padding-inline: 0.4rem;
			border: 1px solid var(--border);
			border-radius: var(--radius);
		}

		.row.open .entry {
			border-color: var(--border-strong);
			background: color-mix(in srgb, var(--surface-alt) 45%, transparent);
		}

		/* Which note belongs to which entry: a hairline arrowhead in the gutter
		   under the opened entry, pointing down at the band it just opened. */
		.row.open .entry::after {
			content: '';
			position: absolute;
			left: 50%;
			bottom: calc(-0.5 * var(--gap) - 0.32rem);
			width: 0.64rem;
			height: 0.64rem;
			transform: translateX(-50%) rotate(45deg);
			border-right: 1px solid var(--border-strong);
			border-bottom: 1px solid var(--border-strong);
		}

		/* No longer a rule down one margin but a note pinned across the page, so
		   the dashed hairline closes into a frame and picks up the same wash as
		   the entry it hangs from. */
		.detail {
			grid-column: 1 / -1;
			margin: 0;
			padding: 0.9rem 1.1rem 1rem;
			border: 1px dashed var(--border-strong);
			border-radius: var(--radius);
			background: color-mix(in srgb, var(--surface-alt) 45%, transparent);
			columns: 2;
			column-gap: var(--gap);
		}

		/* Inside it: a run of independent blocks of very different heights, which
		   is the `.spread-flow` case rather than the `.spread` one. Multi-column
		   reads in source order and balances itself, where a grid would leave a
		   hole under every short block while it waited for the facts sheet.
		   Forgetting spans back across both columns so it stays at the foot. */
		.facts,
		.strength-block,
		.notes,
		.history {
			break-inside: avoid;
		}

		.forget-block {
			column-span: all;
		}

		/* The band is as wide as the ledger; the sentences inside it are not. */
		.notes,
		.sub.none,
		.forget-warning {
			max-width: var(--measure);
		}

		/* The row above already spans the full control width; only the input
		   itself is capped, so a wide card doesn't hand a search box the
		   whole width of a grid meant for something else. */
		.search {
			max-width: 24rem;
		}

		/* The glossary card is as wide as the ledger above it, but its
		   definitions are paragraphs: six independent entries flow into two
		   columns (source order, self-balancing), each still capped at the
		   reading measure. */
		.glossary-list {
			columns: 2;
			column-gap: var(--gap);
		}

		/* The gap between entries becomes a bottom margin: a top margin on the
		   first entry of the second column would leave it hanging low. */
		.entry-def {
			break-inside: avoid;
			max-width: var(--measure);
			margin-bottom: 0.9rem;
		}

		.entry-def + .entry-def {
			margin-top: 0;
		}
	}

	/* 72rem: a third column, once the viewport is genuinely desktop-sized. */
	@media (min-width: 72rem) {
		.ledger {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	/* At phone width the meaning line is worth more than a second stat column,
	   so the readout drops under the word and stays on one line. */
	@media (max-width: 400px) {
		.entry-main {
			grid-template-columns: 0.85rem minmax(0, 1fr);
			gap: 0.35rem 0.5rem;
		}

		.readout {
			grid-column: 2;
			flex-direction: row;
			align-items: center;
			justify-content: flex-start;
			gap: 0.45rem;
		}

		.facts {
			grid-template-columns: repeat(auto-fit, minmax(6.2rem, 1fr));
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caret,
		.summary-caret,
		.dir .ico {
			transition: none;
		}

		.tile:active {
			transform: none;
		}
	}
</style>
