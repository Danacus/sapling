<!--
  Everything the generator is told about the *person*: who they are, what they
  care about, and how far along they are. App configuration (key, model, voice,
  backups) stays on /settings — the split is person-facts here, machine-facts
  there, so neither page has to explain why half of it is about the other.

  Nothing here autosaves. These fields are prose and taste, not toggles: a
  half-typed sentence must not become the thing every lesson is built around,
  so the write happens only when the learner says so.
-->
<script lang="ts">
	import { browser } from '$app/environment';

	import { getProfile, saveProfile } from '$lib/db';
	import { MAX_ABOUT_CHARS } from '$lib/llm';
	import type { Level, Profile } from '$lib/types';
	import InlineStatus from '$lib/ui/InlineStatus.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	type Status = 'idle' | 'saved' | 'error';

	/** Same four cards as onboarding, so the level means the same thing here. */
	const LEVELS: { value: Level; emoji: string; title: string; blurb: string }[] = [
		{ value: 'beginner', emoji: '🌱', title: 'Beginner', blurb: 'Starting from zero' },
		{ value: 'elementary', emoji: '🌿', title: 'Elementary', blurb: 'Know a few basics' },
		{ value: 'intermediate', emoji: '🌳', title: 'Intermediate', blurb: 'Can hold a chat' },
		{ value: 'advanced', emoji: '🏔️', title: 'Advanced', blurb: 'Polishing the details' }
	];

	const INTEREST_SUGGESTIONS = [
		'travel',
		'cooking',
		'music',
		'films & TV',
		'football',
		'work & business',
		'video games',
		'books'
	];

	const ABOUT_PLACEHOLDER =
		'e.g. I am a nurse in Valencia, I live with my partner and two kids, and I climb most weekends.';

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);

	// The editable copies. Kept apart from `profile` so an abandoned edit is
	// discarded by a reload rather than half-persisted.
	let about = $state('');
	let level = $state<Level>('beginner');
	let interests = $state<string[]>([]);
	let interestDraft = $state('');

	let saving = $state(false);
	let saveStatus = $state<Status>('idle');
	let saveMessage = $state('');

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		getProfile()
			.then((loaded) => {
				if (cancelled) return;
				profile = loaded;
				about = loaded?.about ?? '';
				level = loaded?.level ?? 'beginner';
				interests = [...(loaded?.interests ?? [])];
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your profile.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/**
	 * Counted against the same cap the prompt builder enforces, so the number the
	 * learner watches is the number of characters that actually travel.
	 */
	const aboutRemaining = $derived(MAX_ABOUT_CHARS - about.length);

	const remainingSuggestions = $derived(
		INTEREST_SUGGESTIONS.filter(
			(suggestion) => !interests.some((i) => i.toLowerCase() === suggestion.toLowerCase())
		)
	);

	function addInterest(raw: string) {
		const value = raw.trim().replace(/,+$/, '').trim();
		if (!value) return;
		if (!interests.some((i) => i.toLowerCase() === value.toLowerCase())) {
			interests = [...interests, value];
		}
		interestDraft = '';
	}

	function removeInterest(value: string) {
		interests = interests.filter((i) => i !== value);
	}

	function onInterestKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addInterest(interestDraft);
		} else if (event.key === 'Backspace' && interestDraft === '' && interests.length > 0) {
			interests = interests.slice(0, -1);
		}
	}

	async function save() {
		if (!profile || saving) return;
		saving = true;
		saveStatus = 'idle';

		// A tag still sitting in the input is one the learner clearly meant to add;
		// making them press Enter first would just lose it silently.
		const pending = interestDraft.trim();
		if (pending) addInterest(pending);

		const trimmed = about.trim();
		try {
			const updated: Profile = {
				...profile,
				level,
				interests: [...interests],
				about: trimmed
			};
			// Absent rather than empty: a cleared self-description should look
			// exactly like never having written one — in storage, in the export, and
			// to the prompt builder, which only checks for non-blank.
			if (!trimmed) delete updated.about;

			await saveProfile(updated);
			profile = updated;
			about = trimmed;
			saveMessage = 'Saved';
			saveStatus = 'saved';
			setTimeout(() => (saveStatus = 'idle'), 1800);
		} catch (cause) {
			saveMessage = cause instanceof Error ? cause.message : 'Could not save your profile.';
			saveStatus = 'error';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>Profile</title>
</svelte:head>

<main class="shell">
	<header class="topbar ll-rise">
		<a class="back" href="/" aria-label="Back to home">
			<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
				<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
			</svg>
		</a>
		<div class="identity">
			<p class="eyebrow">Sapling</p>
			<h1>Profile</h1>
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
		<section class="card ll-rise" style="animation-delay: 60ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.8 19.2h3.1L19 8.1a2.2 2.2 0 0 0-3.1-3.1L4.8 16.1Z" />
					<path d="m14.9 6.1 3 3" />
				</svg>
				<h2>About you</h2>
			</div>
			<hr class="stitch" />
			<p class="hint lead">
				Written in your own words, and used to build your lessons: scenarios set where you live,
				examples about what you do, people who fit your life. It is sent along with each lesson
				request to {profile?.model ?? 'your model'} through OpenRouter with your own key — the same
				place your lessons already come from, and nowhere else.
			</p>

			<div class="field">
				<label class="label" for="about">About me</label>
				<textarea
					id="about"
					class="input about"
					rows="5"
					maxlength={MAX_ABOUT_CHARS}
					bind:value={about}
					placeholder={ABOUT_PLACEHOLDER}
				></textarea>
				<p class="hint count" class:tight={aboutRemaining <= 50}>
					{aboutRemaining} character{aboutRemaining === 1 ? '' : 's'} left
				</p>
			</div>

			<div class="field">
				<span class="label">Interests</span>
				{#if interests.length > 0}
					<div class="chips">
						{#each interests as interest (interest)}
							<button
								type="button"
								class="chip selected"
								onclick={() => removeInterest(interest)}
								aria-label={`Remove ${interest}`}
							>
								{interest}<svg class="ico x" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						{/each}
					</div>
				{/if}
				<input
					class="input"
					bind:value={interestDraft}
					onkeydown={onInterestKeydown}
					onblur={() => addInterest(interestDraft)}
					placeholder="Type a topic and press Enter"
					autocomplete="off"
					aria-label="Add an interest"
				/>
				{#if remainingSuggestions.length > 0}
					<div class="chips suggestions">
						{#each remainingSuggestions as suggestion (suggestion)}
							<button type="button" class="chip" onclick={() => addInterest(suggestion)}>
								+ {suggestion}
							</button>
						{/each}
					</div>
				{/if}
			</div>

			<div class="field">
				<span class="label">Your level</span>
				<div class="levels">
					{#each LEVELS as option (option.value)}
						<button
							type="button"
							class="level"
							class:selected={level === option.value}
							aria-pressed={level === option.value}
							onclick={() => (level = option.value)}
						>
							<span class="level-emoji" aria-hidden="true">{option.emoji}</span>
							<span class="level-title">{option.title}</span>
							<span class="level-blurb">{option.blurb}</span>
						</button>
					{/each}
				</div>
			</div>

			<div class="actions-row">
				<button
					type="button"
					class="btn btn-primary"
					onclick={() => void save()}
					disabled={saving || !profile}
				>
					{saving ? 'Saving…' : 'Save profile'}
				</button>
				<InlineStatus status={saveStatus} message={saveMessage} />
			</div>

			<!--
			  Challenges already in the queue were written against the old profile;
			  saying so here is cheaper than fielding "I changed this and nothing
			  happened" once per edit.
			-->
			<p class="hint">
				Changes shape newly generated lessons. Anything already waiting in your queue was written
				before this and stays as it is.
			</p>
		</section>

		{#if profile}
			<section class="card ll-rise" style="animation-delay: 120ms">
				<div class="card-head">
					<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.2" />
						<path d="M3.9 12h16.2" />
						<path d="M12 3.8c2.3 2.2 3.6 5.1 3.6 8.2s-1.3 6-3.6 8.2c-2.3-2.2-3.6-5.1-3.6-8.2s1.3-6 3.6-8.2Z" />
					</svg>
					<h2>Languages</h2>
				</div>
				<hr class="stitch" />
				<p class="readonly-row">
					<span class="readonly-label">Learning</span>
					<span class="readonly-value">
						{profile.targetLanguage} <span class="muted">from</span> {profile.nativeLanguage}
					</span>
				</p>
				<p class="hint">
					Your languages are fixed once you start — every word you have learned is stored against
					them. Starting a different language means resetting your progress in
					<a href="/settings">settings</a>.
				</p>
			</section>
		{/if}
	{/if}
</main>

<style>
	.shell {
		max-width: 34rem;
		margin: 0 auto;
		padding: 2rem 1rem 4rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	/* One hand for every icon on this screen, matching the dashboard: 24-unit
	   box, hairline stroke, round joins. */
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

	/* The same squircle the dashboard's topbar controls wear. */
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

	.card {
		max-width: none;
	}

	/* Each card is headed like a pressed specimen: its mark on tinted paper in
	   a dashed frame, then the app's stitched rule under the heading. */
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

	.lead {
		margin: 0 0 1.25rem;
	}

	/*
	  The one place on the page where you actually write something, so it is
	  ruled like a notebook. The rule period and the line height are the same
	  `1.5rem` on purpose — tie them together and the ink always lands on the
	  line, whatever the root font size is. `local` makes the ruling scroll
	  with the text rather than sitting still behind it.
	*/
	.about {
		resize: vertical;
		min-height: 7.5rem;
		padding-top: 0.75rem;
		line-height: 1.5rem;
		background-image: repeating-linear-gradient(
			to bottom,
			transparent 0,
			transparent calc(1.5rem - 1px),
			color-mix(in srgb, var(--border) 75%, transparent) calc(1.5rem - 1px),
			color-mix(in srgb, var(--border) 75%, transparent) 1.5rem
		);
		background-attachment: local;
		background-position: 0 0.75rem;
	}

	.count {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.count.tight {
		color: var(--danger);
		font-weight: 700;
	}

	/* A ruled ledger row: the fact left, its value right. */
	.readonly-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin: 0 0 0.9rem;
		padding-bottom: 0.6rem;
		border-bottom: 1px solid var(--border);
		font-size: 0.95rem;
	}

	.readonly-label {
		flex: 0 0 auto;
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.readonly-value {
		text-align: right;
		font-weight: 600;
	}

	.muted {
		color: var(--text-muted);
		font-weight: 400;
	}

	/* Chips ---------------------------------------------------------------- */

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.6rem;
	}

	.suggestions {
		margin: 0.6rem 0 0;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.7rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.83rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.chip:hover {
		border-color: var(--text-muted);
		background: var(--surface-alt);
		color: var(--text);
	}

	.chip.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 700;
	}

	.chip .x {
		width: 0.8rem;
		height: 0.8rem;
		stroke-width: 2;
		opacity: 0.55;
	}

	.chip:hover .x {
		opacity: 1;
	}

	/* Level cards ---------------------------------------------------------- */

	.levels {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}

	/* The same four cards as onboarding, down to the press: a hairline frame
	   with a thicker bottom edge that collapses under the tap. */
	.level {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.85rem 0.9rem;
		border: 1.5px solid var(--border);
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

	.level:hover {
		border-color: var(--border-strong);
	}

	.level:active {
		transform: translateY(1px);
		border-bottom-width: 1.5px;
	}

	.level.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.level:focus-visible,
	.chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.level-emoji {
		font-size: 1.25rem;
		line-height: 1.2;
	}

	.level-title {
		font-family: var(--font-display);
		font-size: 1.02rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
	}

	.level-blurb {
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.actions-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.error {
		margin: 0.85rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	@media (max-width: 420px) {
		.levels {
			grid-template-columns: 1fr;
		}
	}
</style>
