<script lang="ts">
	import { goto } from '$app/navigation';

	import { DEFAULT_MODEL, saveProfile, setApiKey, setModel } from '$lib/db';
	import type { Level, Profile } from '$lib/types';

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

	const LEVELS: { value: Level; emoji: string; title: string; blurb: string }[] = [
		{ value: 'beginner', emoji: '🌱', title: 'Beginner', blurb: 'Starting from zero' },
		{ value: 'elementary', emoji: '🌿', title: 'Elementary', blurb: 'Know a few basics' },
		{ value: 'intermediate', emoji: '🌳', title: 'Intermediate', blurb: 'Can hold a chat' },
		{ value: 'advanced', emoji: '🏔️', title: 'Advanced', blurb: 'Polishing the details' }
	];

	const GOALS = [
		{ xp: 30, label: 'Casual', minutes: '~5 min/day' },
		{ xp: 60, label: 'Regular', minutes: '~10 min/day' },
		{ xp: 120, label: 'Serious', minutes: '~20 min/day' }
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
	let interestDraft = $state('');
	let dailyGoalXp = $state(60);
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

	const remainingSuggestions = $derived(
		INTEREST_SUGGESTIONS.filter((suggestion) => !interests.includes(suggestion))
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
				dailyGoalXp,
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
	<section class="card">
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
				<div class="emoji" aria-hidden="true">👋</div>
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
				<div class="emoji" aria-hidden="true">🎯</div>
				<h1>Tune it to you</h1>
				<p class="sub">
					This shapes the words and sentences we generate in {targetLanguage.trim() ||
						'your new language'}.
				</p>
			</header>

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
								{interest}<span class="x" aria-hidden="true">×</span>
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
				<span class="label">Daily goal</span>
				<div class="goals">
					{#each GOALS as goal (goal.xp)}
						<button
							type="button"
							class="goal"
							class:selected={dailyGoalXp === goal.xp}
							aria-pressed={dailyGoalXp === goal.xp}
							onclick={() => (dailyGoalXp = goal.xp)}
						>
							<span class="goal-xp">{goal.xp} XP</span>
							<span class="goal-label">{goal.label}</span>
							<span class="goal-minutes">{goal.minutes}</span>
						</button>
					{/each}
				</div>
			</div>
		{:else}
			<header class="head">
				<div class="emoji" aria-hidden="true">🔑</div>
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

	.head {
		text-align: center;
		margin-bottom: 1.5rem;
	}

	.emoji {
		font-size: 2.5rem;
		line-height: 1;
		margin-bottom: 0.5rem;
	}

	.head h1 {
		font-size: 1.6rem;
	}

	.sub {
		margin: 0;
		color: var(--text-muted);
	}

	.dots {
		display: flex;
		justify-content: center;
		gap: 0.5rem;
		margin-bottom: 1.5rem;
	}

	.dot {
		width: 0.6rem;
		height: 0.6rem;
		border-radius: 999px;
		background: var(--border-strong);
		transition:
			width 0.2s ease,
			background 0.2s ease;
	}

	.dot.done {
		background: var(--primary);
	}

	.dot.active {
		width: 1.6rem;
		background: var(--primary);
	}

	/* Level cards ---------------------------------------------------------- */

	.levels {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.6rem;
	}

	.level {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.9rem;
		border: 2px solid var(--border);
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
	}

	.level.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.level:focus-visible,
	.goal:focus-visible,
	.chip:focus-visible,
	.skip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.level-emoji {
		font-size: 1.3rem;
	}

	.level-title {
		font-weight: 800;
	}

	.level-blurb {
		font-size: 0.8rem;
		color: var(--text-muted);
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
		gap: 0.35rem;
		padding: 0.35rem 0.75rem;
		border: 2px solid var(--border);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.chip:hover {
		border-color: var(--border-strong);
		color: var(--text);
	}

	.chip.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
	}

	.chip .x {
		font-size: 1rem;
		line-height: 1;
		opacity: 0.6;
	}

	/* Goals ---------------------------------------------------------------- */

	.goals {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.6rem;
	}

	.goal {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.1rem;
		padding: 0.8rem 0.4rem;
		border: 2px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.goal.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
	}

	.goal-xp {
		font-weight: 800;
	}

	.goal-label {
		font-size: 0.85rem;
	}

	.goal-minutes {
		font-size: 0.75rem;
		color: var(--text-muted);
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
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.9rem;
		font-weight: 700;
		text-decoration: underline;
		cursor: pointer;
	}

	.error {
		margin: 1rem 0 0;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	@media (max-width: 420px) {
		.levels,
		.goals {
			grid-template-columns: 1fr;
		}
	}
</style>
