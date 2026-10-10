<!--
  Everything the generator is told about the *person*: who they are, in their
  own words. How far along they are is not asked — every prompt reads the level
  off the size of their word list — and the old interests list is gone too:
  "About me" personalises better. The stored profile still carries both for
  older builds, and a save here keeps whatever they held. App configuration (key, model, voice,
  backups) stays on /settings — the split is person-facts here, machine-facts
  there, so neither page has to explain why half of it is about the other.

  Nothing in "About you" autosaves. Those fields are prose and taste, not
  toggles: a half-typed sentence must not become the thing every lesson is
  built around, so the write happens only when the learner says so. The one
  toggle here, how hard practice aims, saves the moment it is picked: it is a
  setting, it rebuilds nothing, and it takes effect on the next pick.
-->
<script lang="ts">
	import { browser } from '$app/environment';

	import { getProfile, saveProfile } from '$lib/db';
	import { MAX_ABOUT_CHARS } from '$lib/llm';
	import type { Aim, Profile } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import InlineStatus from '$lib/ui/InlineStatus.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	type Status = 'idle' | 'saved' | 'error';

	const ABOUT_PLACEHOLDER =
		'e.g. I am a nurse in Valencia, I live with my partner and two kids, and I climb most weekends.';

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);

	// The editable copy. Kept apart from `profile` so an abandoned edit is
	// discarded by a reload rather than half-persisted.
	let about = $state('');

	let saving = $state(false);
	let saveStatus = $state<Status>('idle');
	let saveMessage = $state('');

	/**
	 * How hard practice aims: the success rate the difficulty model picks
	 * challenges for (`crates/sapling-challenges`' `data/model.json`). Absent
	 * on a profile reads as normal.
	 */
	const AIMS: { value: Aim; title: string; blurb: string }[] = [
		{ value: 'easier', title: 'Easier', blurb: 'About 9 in 10 right' },
		{ value: 'normal', title: 'Normal', blurb: 'About 8 in 10 right' },
		{ value: 'harder', title: 'Harder', blurb: 'About 7 in 10 right' }
	];
	let aimStatus = $state<Status>('idle');
	let aimMessage = $state('');

	async function chooseAim(aim: Aim) {
		if (!profile || (profile.aim ?? 'normal') === aim) return;
		const updated: Profile = { ...profile, aim };
		try {
			await saveProfile(updated);
			profile = updated;
			aimMessage = 'Saved';
			aimStatus = 'saved';
			setTimeout(() => (aimStatus = 'idle'), 1800);
		} catch (cause) {
			aimMessage = cause instanceof Error ? cause.message : 'Could not save that.';
			aimStatus = 'error';
		}
	}

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

	async function save() {
		if (!profile || saving) return;
		saving = true;
		saveStatus = 'idle';

		const trimmed = about.trim();
		try {
			// The spread keeps the deprecated `level` and `interests` exactly as
			// stored: nothing reads them, but an older build on another device
			// still parses them.
			const updated: Profile = { ...profile, about: trimmed };
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
		<BackLink href="/" label="Back to home" />
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
			<p class="hint lead">Used to write your lessons around your life.</p>

			<div class="field">
				<label class="label" for="about">About me</label>
				<textarea
					id="about"
					class="input about"
					rows="5"
					maxlength={MAX_ABOUT_CHARS}
					bind:value={about}
					placeholder={ABOUT_PLACEHOLDER}></textarea>
				<p class="hint count" class:tight={aboutRemaining <= 50}>
					{aboutRemaining} character{aboutRemaining === 1 ? '' : 's'} left
				</p>
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
			<p class="hint">Applies to new lessons only.</p>
		</section>

		{#if profile}
			<section class="card ll-rise" style="animation-delay: 90ms">
				<div class="card-head">
					<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.2" />
						<circle cx="12" cy="12" r="4.4" />
						<circle cx="12" cy="12" r="0.9" />
					</svg>
					<h2>Practice</h2>
				</div>
				<hr class="stitch" />
				<p class="hint lead">
					How often you should get a challenge right. Practice picks each one to land there, from
					how your answers have gone.
				</p>
				<div class="aims" role="group" aria-label="How hard practice aims">
					{#each AIMS as option (option.value)}
						<button
							type="button"
							class="aim"
							class:selected={(profile.aim ?? 'normal') === option.value}
							aria-pressed={(profile.aim ?? 'normal') === option.value}
							onclick={() => void chooseAim(option.value)}
						>
							<span class="aim-title">{option.title}</span>
							<span class="aim-blurb">{option.blurb}</span>
						</button>
					{/each}
				</div>
				<InlineStatus status={aimStatus} message={aimMessage} />
			</section>

			<section class="card ll-rise" style="animation-delay: 120ms">
				<div class="card-head">
					<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.2" />
						<path d="M3.9 12h16.2" />
						<path
							d="M12 3.8c2.3 2.2 3.6 5.1 3.6 8.2s-1.3 6-3.6 8.2c-2.3-2.2-3.6-5.1-3.6-8.2s1.3-6 3.6-8.2Z"
						/>
					</svg>
					<h2>Languages</h2>
				</div>
				<hr class="stitch" />
				<p class="readonly-row">
					<span class="readonly-label">Learning</span>
					<span class="readonly-value">
						{profile.targetLanguage} <span class="muted">from</span>
						{profile.nativeLanguage}
					</span>
				</p>
				<p class="hint">
					Fixed for this library. Add or switch languages from <a href="/">home</a>.
				</p>
			</section>
		{/if}
	{/if}
</main>

<style>
	/* Width and horizontal padding are the global `.shell`'s job. This page
	   stays at the default `--measure`: the "About me" textarea is prose, and
	   the other card is a short ledger, so there is no case for widening past
	   the reading column, and only two cards (one of them conditional) is not
	   enough to justify a `.spread`. */
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

	/* Three choices in one row even on a phone: short labels, in the app's
	   pressed-card hand. */
	.aims {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin-bottom: 0.5rem;
	}

	.aim {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		padding: 0.7rem 0.75rem;
		border: 1.5px solid var(--border);
		border-bottom-width: 3px;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.aim:hover {
		border-color: var(--border-strong);
	}

	.aim:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.aim.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.aim-title {
		font-weight: 700;
	}

	.aim-blurb {
		font-size: 0.78rem;
		color: var(--text-muted);
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
</style>
