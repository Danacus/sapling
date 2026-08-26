<script lang="ts">
	import { goto } from '$app/navigation';

	import { DEFAULT_MODEL, saveProfile, setApiKey, setModel } from '$lib/db';
	import type { Level, Profile } from '$lib/types';
	import InterestPicker from '$lib/ui/InterestPicker.svelte';
	import LevelPicker from '$lib/ui/LevelPicker.svelte';

	const TOTAL_STEPS = 3;

	/** Datalist suggestions; learners may still type anything. */
	const LANGUAGES = [
		'English',
		'Spanish',
		'French',
		'German',
		'Italian',
		'Portuguese',
		'Dutch',
		'Swedish',
		'Norwegian',
		'Danish',
		'Polish',
		'Czech',
		'Greek',
		'Turkish',
		'Russian',
		'Ukrainian',
		'Arabic',
		'Hebrew',
		'Hindi',
		'Mandarin Chinese',
		'Japanese',
		'Korean',
		'Vietnamese',
		'Indonesian'
	];

	const MODELS = [
		'google/gemini-2.5-flash-lite',
		'google/gemini-2.5-flash',
		'openai/gpt-4o-mini',
		'anthropic/claude-3.5-haiku',
		'meta-llama/llama-3.3-70b-instruct'
	];

	let step = $state(1);

	let nativeLanguage = $state('');
	let targetLanguage = $state('');
	let level = $state<Level | undefined>(undefined);
	let interests = $state<string[]>([]);
	let apiKey = $state('');
	let model = $state(DEFAULT_MODEL);

	let saving = $state(false);
	let error = $state('');

	const canContinue = $derived(
		step === 1
			? nativeLanguage.trim().length > 0 &&
					targetLanguage.trim().length > 0 &&
					nativeLanguage.trim().toLowerCase() !== targetLanguage.trim().toLowerCase()
			: step === 2
				? level !== undefined
				: true
	);

	function back() {
		error = '';
		if (step > 1) step -= 1;
	}

	function next() {
		error = '';
		if (!canContinue) return;
		if (step < TOTAL_STEPS) step += 1;
	}

	async function finish() {
		if (saving) return;
		error = '';
		saving = true;
		try {
			const chosenModel = model.trim() || DEFAULT_MODEL;
			const profile: Profile = {
				nativeLanguage: nativeLanguage.trim(),
				targetLanguage: targetLanguage.trim(),
				level: level ?? 'beginner',
				interests,
				model: chosenModel,
				createdAt: Date.now()
			};

			await saveProfile(profile);
			setModel(chosenModel);
			if (apiKey.trim()) setApiKey(apiKey);

			await goto('/');
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not save your profile.';
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>Welcome</title>
</svelte:head>

<main class="shell">
	<section class="card ll-rise">
		<nav class="dots" aria-label="Onboarding progress">
			{#each { length: TOTAL_STEPS } as _, index (index)}
				<span
					class="dot"
					class:active={index + 1 === step}
					class:done={index + 1 < step}
					aria-current={index + 1 === step ? 'step' : undefined}
				></span>
			{/each}
		</nav>

		{#if step === 1}
			<header class="head">
				<span class="mark" aria-hidden="true">
					<svg class="ico" viewBox="0 0 24 24">
						<path d="M12 21v-8.6" />
						<path d="M12 16.2c-3.3 0-5.2-1.9-5.2-5.2 3.3 0 5.2 1.9 5.2 5.2Z" />
						<path d="M12 12.6c0-3.8 2-5.8 5.6-5.8 0 3.8-2 5.8-5.6 5.8Z" />
					</svg>
				</span>
				<h1>Let's set you up</h1>
				<p class="sub">Which language are you bringing, and which one are you here for?</p>
			</header>

			<label class="field">
				<span class="label">I speak</span>
				<input
					class="input"
					list="languages"
					bind:value={nativeLanguage}
					placeholder="e.g. English"
					autocomplete="off"
				/>
			</label>

			<label class="field">
				<span class="label">I want to learn</span>
				<input
					class="input"
					list="languages"
					bind:value={targetLanguage}
					placeholder="e.g. Spanish"
					autocomplete="off"
				/>
			</label>

			<datalist id="languages">
				{#each LANGUAGES as language (language)}
					<option value={language}></option>
				{/each}
			</datalist>

			{#if nativeLanguage.trim() && nativeLanguage.trim().toLowerCase() === targetLanguage
					.trim()
					.toLowerCase()}
				<p class="hint">Pick two different languages to get started.</p>
			{/if}
		{:else if step === 2}
			<header class="head">
				<span class="mark" aria-hidden="true">
					<svg class="ico" viewBox="0 0 24 24">
						<circle cx="12" cy="12" r="7.4" />
						<circle cx="12" cy="12" r="3.2" />
						<path d="M12 4.6V2.4M12 21.6v-2.2M4.6 12H2.4M21.6 12h-2.2" />
					</svg>
				</span>
				<h1>Tune it to you</h1>
				<p class="sub">
					This shapes the words and sentences we generate in {targetLanguage.trim() ||
						'your new language'}.
				</p>
			</header>

			<div class="field">
				<span class="label">Your level</span>
				<LevelPicker bind:level />
			</div>

			<div class="field">
				<span class="label">Interests</span>
				<InterestPicker bind:interests />
			</div>
		{:else}
			<header class="head">
				<span class="mark" aria-hidden="true">
					<svg class="ico" viewBox="0 0 24 24">
						<circle cx="7.2" cy="12" r="3.9" />
						<path d="M11.1 12h9.3" />
						<path d="M17.2 12v3.3" />
						<path d="M20.4 12v2.3" />
					</svg>
				</span>
				<h1>Connect a model</h1>
				<p class="sub">
					Lessons are generated on the fly through OpenRouter. Add your key now, or skip and add it
					later in settings.
				</p>
			</header>

			<label class="field">
				<span class="label">OpenRouter API key</span>
				<input
					class="input"
					type="password"
					bind:value={apiKey}
					placeholder="sk-or-v1-..."
					autocomplete="off"
					spellcheck="false"
				/>
				<p class="hint">
					Stored only in your browser — it never leaves this device except to call OpenRouter. Create
					one at
					<a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer noopener"
						>openrouter.ai/keys</a
					>.
				</p>
			</label>

			<label class="field">
				<span class="label">Model</span>
				<input
					class="input"
					list="models"
					bind:value={model}
					placeholder={DEFAULT_MODEL}
					autocomplete="off"
					spellcheck="false"
				/>
				<datalist id="models">
					{#each MODELS as option (option)}
						<option value={option}></option>
					{/each}
				</datalist>
				<p class="hint">Fast and cheap by default. Any OpenRouter model id works.</p>
			</label>
		{/if}

		{#if error}
			<p class="error" role="alert">{error}</p>
		{/if}

		<footer class="actions">
			{#if step > 1}
				<button type="button" class="btn btn-ghost" onclick={back} disabled={saving}>Back</button>
			{/if}

			{#if step < TOTAL_STEPS}
				<button type="button" class="btn btn-primary grow" onclick={next} disabled={!canContinue}>
					Continue
				</button>
			{:else}
				<button type="button" class="btn btn-primary grow" onclick={finish} disabled={saving}>
					{saving ? 'Saving…' : 'Start learning'}
				</button>
			{/if}
		</footer>

		{#if step === TOTAL_STEPS && !apiKey.trim()}
			<button type="button" class="skip" onclick={finish} disabled={saving}>Skip for now</button>
		{/if}
	</section>
</main>

<style>
	.shell {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: 2rem 1rem;
	}

	/* One hand for every icon on this screen, matching the dashboard: 24-unit
	   box, hairline stroke, round joins. */
	.ico {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* The head is closed with the app's stitched hairline, so each step reads
	   as an entry written under its own heading. */
	.head {
		text-align: center;
		padding-bottom: 1.35rem;
		margin-bottom: 1.5rem;
		border-bottom: 1px dashed var(--border-strong);
	}

	/* A pressed specimen label: the step's mark mounted on tinted paper inside
	   a dashed frame. */
	.mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		margin-bottom: 0.85rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--primary-soft) 65%, transparent);
		color: var(--primary-strong);
	}

	.mark .ico {
		width: 1.5rem;
		height: 1.5rem;
	}

	.head h1 {
		font-size: clamp(1.6rem, 7vw, 1.95rem);
	}

	.sub {
		margin: 0;
		color: var(--text-muted);
		text-wrap: balance;
	}

	/* Ruled ticks rather than beads — the current step stretches into a dash. */
	.dots {
		display: flex;
		justify-content: center;
		gap: 0.4rem;
		margin-bottom: 1.5rem;
	}

	.dot {
		width: 0.55rem;
		height: 0.3rem;
		border-radius: 2px;
		background: var(--border-strong);
		transition:
			width 0.24s cubic-bezier(0.2, 0.7, 0.3, 1),
			background 0.2s ease;
	}

	.dot.done {
		background: var(--primary);
	}

	.dot.active {
		width: 1.8rem;
		background: var(--accent);
	}

	@media (prefers-reduced-motion: reduce) {
		.dot {
			transition: none;
		}
	}

	.skip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* Footer --------------------------------------------------------------- */

	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 1.5rem;
	}

	.grow {
		flex: 1;
	}

	.skip {
		display: block;
		width: 100%;
		margin-top: 0.75rem;
		padding: 0.5rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 0.2em;
		text-decoration-thickness: 1px;
		cursor: pointer;
	}

	.skip:hover {
		color: var(--text);
	}

	.error {
		margin: 1rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

</style>
