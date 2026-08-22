<script lang="ts">
	import { browser } from '$app/environment';

	import {
		clearApiKey,
		db,
		DEFAULT_MODEL,
		exportData,
		getApiKey,
		getModel,
		getProfile,
		importData,
		saveProfile,
		setApiKey,
		setModel
	} from '$lib/db';
	import {
		formatMb,
		getTtsEngine,
		getTtsVoice,
		kokoroSupports,
		MANDARIN_SPEAKERS,
		preloadKokoro,
		RUNTIME_DOWNLOAD_BYTES,
		setTtsEngine,
		setTtsVoice,
		type TtsEngine,
		type TtsVoice
	} from '$lib/tts';
	import type { Profile } from '$lib/types';
	import InlineStatus from '$lib/ui/InlineStatus.svelte';
	import { getShowRomanization, setShowRomanization } from '$lib/ui/prefs';
	import ProgressBar from '$lib/ui/ProgressBar.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	type Status = 'idle' | 'saved' | 'error';

	const GOAL_PRESETS = [30, 60, 120];
	const MODEL_SUGGESTIONS = [
		'google/gemini-2.5-flash-lite',
		'google/gemini-2.5-flash',
		'openai/gpt-5-nano',
		'meta-llama/llama-4-maverick',
		'anthropic/claude-haiku-4.5'
	];

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);

	// Profile / goal ------------------------------------------------------------
	let dailyGoalXp = $state(60);
	let savingGoal = $state(false);
	let goalStatus = $state<Status>('idle');
	let goalMessage = $state('');

	// Display -----------------------------------------------------------------------
	let showRomanization = $state(true);

	// Speech ----------------------------------------------------------------------
	let ttsEngine = $state<TtsEngine>('kokoro');
	let ttsVoice = $state<TtsVoice>('auto');
	let preloading = $state(false);
	/** 0-100 across the model files, or `null` while the size is still unknown. */
	let preloadPercent = $state<number | null>(null);
	let preloadStatus = $state<Status>('idle');
	let preloadMessage = $state('');
	/** Bytes seen per file, so the percentage is over the whole download. */
	let preloadBytes = new Map<string, { loaded: number; total: number }>();

	// LLM: API key ----------------------------------------------------------------
	let apiKeySet = $state(false);
	let apiKeyInput = $state('');
	let apiKeyStatus = $state<Status>('idle');
	let apiKeyMessage = $state('');

	// LLM: model --------------------------------------------------------------------
	let modelInput = $state(DEFAULT_MODEL);
	let modelStatus = $state<Status>('idle');
	let modelMessage = $state('');

	// Usage -------------------------------------------------------------------------
	let usagePromptTokens = $state(0);
	let usageCompletionTokens = $state(0);
	let usageRequests = $state(0);

	// Export / import -----------------------------------------------------------
	let exportStatus = $state<Status>('idle');
	let exportMessage = $state('');
	let importing = $state(false);
	let importStatus = $state<Status>('idle');
	let importMessage = $state('');

	// Danger zone -----------------------------------------------------------------
	let resetStage = $state<'idle' | 'confirm'>('idle');
	let resetInput = $state('');
	let resetting = $state(false);
	let resetError = $state('');

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		getProfile()
			.then((loadedProfile) => {
				if (cancelled) return;
				profile = loadedProfile;
				dailyGoalXp = loadedProfile?.dailyGoalXp ?? 60;

				apiKeySet = getApiKey() !== undefined;
				modelInput = getModel();
				showRomanization = getShowRomanization();

				ttsEngine = getTtsEngine();
				ttsVoice = getTtsVoice();

				usagePromptTokens = readUsage('ll.usage.promptTokens');
				usageCompletionTokens = readUsage('ll.usage.completionTokens');
				usageRequests = readUsage('ll.usage.requests');

				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your settings.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/**
	 * Whether Kokoro can actually pronounce what this learner is studying. It
	 * speaks Mandarin and English; everyone else silently gets the browser's own
	 * voice — worth saying out loud rather than leaving them to wonder why the
	 * download changed nothing.
	 */
	const kokoroCoversTarget = $derived(kokoroSupports(profile?.targetLanguage));

	/** e.g. "227 MB" — never hard-coded, so the copy cannot drift. */
	const downloadSize = formatMb(RUNTIME_DOWNLOAD_BYTES);

	function readUsage(key: string): number {
		try {
			const raw = localStorage.getItem(key);
			const parsed = raw ? parseInt(raw, 10) : 0;
			return Number.isFinite(parsed) ? parsed : 0;
		} catch {
			return 0;
		}
	}

	function flash(setStatus: (value: Status) => void, delay = 1800) {
		setStatus('saved');
		setTimeout(() => setStatus('idle'), delay);
	}

	async function saveGoal() {
		if (!profile || savingGoal) return;
		savingGoal = true;
		goalStatus = 'idle';
		try {
			const updated: Profile = { ...profile, dailyGoalXp };
			await saveProfile(updated);
			profile = updated;
			goalMessage = 'Saved';
			flash((value) => (goalStatus = value));
		} catch (cause) {
			goalMessage = cause instanceof Error ? cause.message : 'Could not save your goal.';
			goalStatus = 'error';
		} finally {
			savingGoal = false;
		}
	}

	function saveKey() {
		const trimmed = apiKeyInput.trim();
		if (!trimmed) {
			apiKeyMessage = 'Enter a key first.';
			apiKeyStatus = 'error';
			return;
		}
		try {
			setApiKey(trimmed);
			apiKeySet = true;
			apiKeyInput = '';
			apiKeyMessage = 'Key saved';
			flash((value) => (apiKeyStatus = value));
		} catch (cause) {
			apiKeyMessage = cause instanceof Error ? cause.message : 'Could not save the key.';
			apiKeyStatus = 'error';
		}
	}

	function clearKey() {
		clearApiKey();
		apiKeySet = false;
		apiKeyInput = '';
		apiKeyMessage = 'Key cleared';
		flash((value) => (apiKeyStatus = value));
	}

	function toggleRomanization() {
		showRomanization = !showRomanization;
		setShowRomanization(showRomanization);
	}

	function chooseEngine(engine: TtsEngine) {
		ttsEngine = engine;
		setTtsEngine(engine);
	}

	/** The speaker is a per-generation argument, so nothing has to reload. */
	function chooseVoice(voice: TtsVoice) {
		ttsVoice = voice;
		setTtsVoice(voice);
	}

	/**
	 * Downloads and warms up the Kokoro runtime on demand, so the first word of
	 * the first lesson is not the thing that waits on a few hundred megabytes.
	 */
	async function preloadVoiceModel() {
		if (preloading) return;
		preloading = true;
		preloadStatus = 'idle';
		preloadMessage = '';
		preloadPercent = null;
		preloadBytes = new Map();

		try {
			await preloadKokoro((progress) => {
				preloadBytes.set(progress.file, { loaded: progress.loaded, total: progress.total });
				let loaded = 0;
				let total = 0;
				for (const entry of preloadBytes.values()) {
					loaded += entry.loaded;
					total += entry.total;
				}
				preloadPercent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
			});
			preloadPercent = 100;
			preloadMessage = 'Voice model ready';
			flash((value) => (preloadStatus = value), 3000);
		} catch (cause) {
			preloadPercent = null;
			preloadMessage =
				cause instanceof Error ? cause.message : 'Could not download the voice model.';
			preloadStatus = 'error';
		} finally {
			preloading = false;
		}
	}

	function saveModelChoice() {
		try {
			setModel(modelInput);
			modelInput = getModel();
			modelMessage = 'Saved';
			flash((value) => (modelStatus = value));
		} catch (cause) {
			modelMessage = cause instanceof Error ? cause.message : 'Could not save the model.';
			modelStatus = 'error';
		}
	}

	function backupFilename(): string {
		const date = new Date();
		const year = date.getFullYear();
		const month = `${date.getMonth() + 1}`.padStart(2, '0');
		const day = `${date.getDate()}`.padStart(2, '0');
		return `language-learning-backup-${year}-${month}-${day}.json`;
	}

	async function handleExport() {
		exportStatus = 'idle';
		try {
			const json = await exportData();
			const blob = new Blob([json], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = backupFilename();
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			exportMessage = 'Downloaded';
			flash((value) => (exportStatus = value));
		} catch (cause) {
			exportMessage = cause instanceof Error ? cause.message : 'Could not export your data.';
			exportStatus = 'error';
		}
	}

	async function handleImportChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		importStatus = 'idle';

		const proceed = confirm(
			'Importing a backup replaces all current progress on this device. Continue?'
		);
		if (!proceed) {
			input.value = '';
			return;
		}

		importing = true;
		try {
			const text = await file.text();
			await importData(text);
			location.reload();
		} catch (cause) {
			importMessage = cause instanceof Error ? cause.message : 'Could not import that file.';
			importStatus = 'error';
			importing = false;
		} finally {
			input.value = '';
		}
	}

	function startReset() {
		resetStage = 'confirm';
		resetInput = '';
		resetError = '';
	}

	function cancelReset() {
		resetStage = 'idle';
		resetInput = '';
		resetError = '';
	}

	async function confirmReset() {
		if (resetInput.trim().toUpperCase() !== 'RESET' || resetting) return;
		resetting = true;
		resetError = '';
		try {
			await db.delete();
			try {
				const keys = Object.keys(localStorage).filter((key) => key.startsWith('ll.'));
				for (const key of keys) localStorage.removeItem(key);
			} catch {
				/* ignore: storage unavailable */
			}
			location.href = '/';
		} catch (cause) {
			resetting = false;
			resetError = cause instanceof Error ? cause.message : 'Could not reset your progress.';
		}
	}
</script>

<svelte:head>
	<title>Settings</title>
</svelte:head>

<main class="shell">
	<header class="topbar">
		<a class="back" href="/">← Back</a>
		<h1>Settings</h1>
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
		<section class="card">
			<h2>Profile</h2>
			{#if profile}
				<p class="readonly-row">
					<span class="readonly-label">Learning</span>
					<span class="readonly-value">
						{profile.targetLanguage} <span class="muted">from</span> {profile.nativeLanguage}
					</span>
				</p>
				<p class="readonly-row">
					<span class="readonly-label">Level</span>
					<span class="readonly-value capitalize">{profile.level}</span>
				</p>
			{/if}

			<div class="field">
				<span class="label">Daily XP goal</span>
				<div class="preset-row">
					{#each GOAL_PRESETS as preset (preset)}
						<button
							type="button"
							class="chip"
							class:selected={dailyGoalXp === preset}
							onclick={() => (dailyGoalXp = preset)}
						>
							{preset} XP
						</button>
					{/each}
				</div>
				<input
					class="input"
					type="number"
					min="10"
					step="10"
					bind:value={dailyGoalXp}
					aria-label="Custom daily XP goal"
				/>
			</div>

			<div class="actions-row">
				<button
					type="button"
					class="btn btn-primary"
					onclick={saveGoal}
					disabled={savingGoal || !profile}
				>
					{savingGoal ? 'Saving…' : 'Save goal'}
				</button>
				<InlineStatus status={goalStatus} message={goalMessage} />
			</div>
		</section>

		<section class="card">
			<h2>Display</h2>
			<div class="switch-row">
				<div class="switch-copy">
					<span class="label">Show pronunciation (romanization)</span>
					<p class="hint">
						Pinyin, romaji and the like under words written in a non-Latin script. Only shows up
						for languages that need it.
					</p>
				</div>
				<button
					type="button"
					class="switch"
					class:on={showRomanization}
					role="switch"
					aria-checked={showRomanization}
					aria-label="Show pronunciation (romanization)"
					onclick={toggleRomanization}
				>
					<span class="switch-thumb"></span>
				</button>
			</div>
		</section>

		<section class="card">
			<h2>Speech</h2>
			<p class="hint test-bench-link"><a href="/tts-test">Test voices →</a></p>

			<div class="field">
				<span class="label" id="tts-engine-label">Voice engine</span>
				<select
					class="input"
					aria-labelledby="tts-engine-label"
					value={ttsEngine}
					onchange={(event) => chooseEngine(event.currentTarget.value as TtsEngine)}
				>
					<option value="kokoro">Kokoro (neural) — downloads {downloadSize} once, then offline</option
					>
					<option value="webspeech">Browser built-in — instant, uses your system voices</option>
					<option value="off">Off — no audio anywhere</option>
				</select>
				{#if ttsEngine === 'kokoro' && profile && !kokoroCoversTarget}
					<p class="hint">
						Heads up: Kokoro speaks Mandarin and English, so {profile.targetLanguage} will use your
						browser's built-in voice regardless.
					</p>
				{:else if ttsEngine === 'kokoro'}
					<p class="hint">
						Kokoro v1.1-zh speaks Mandarin (including sentences that mix in English) and English.
						Every other language uses your browser's own voices.
					</p>
				{/if}
			</div>

			{#if ttsEngine === 'kokoro'}
				<div class="field">
					<span class="label" id="tts-voice-label">Mandarin voice</span>
					<select
						class="input"
						aria-labelledby="tts-voice-label"
						value={ttsVoice}
						onchange={(event) => chooseVoice(event.currentTarget.value as TtsVoice)}
					>
						<option value="auto">Default (zf_001, female)</option>
						{#each MANDARIN_SPEAKERS as speaker (speaker.name)}
							<option value={speaker.name}>{speaker.label}</option>
						{/each}
					</select>
					<p class="hint">
						Three of the model's 100 Mandarin speakers. English always uses its own voice (Maple, or
						Vale if your language is set to British English).
					</p>
					<p class="hint">
						Runs on your CPU (WASM + SIMD) in a background thread — there is no GPU path, and none
						is needed for single words and short sentences.
					</p>
				</div>

				<div class="actions-row">
					<button
						type="button"
						class="btn btn-primary"
						onclick={() => void preloadVoiceModel()}
						disabled={preloading}
					>
						{preloading ? 'Downloading…' : 'Preload voice model now'}
					</button>
					<InlineStatus status={preloadStatus} message={preloadMessage} />
				</div>

				<p class="hint">
					{downloadSize} in two files (the sherpa-onnx runtime and the Kokoro model), stored in your
					browser's cache. It happens once per browser profile, and everything works offline
					afterwards. The model is the full-precision build on purpose — the small quantized one is
					half the size but produces silence in WebAssembly.
				</p>
				<p class="hint">
					Synthesis takes roughly a second or two per phrase on a laptop CPU, in a background thread,
					and each clip is remembered for the rest of the session.
				</p>

				{#if preloading}
					<div class="preload-progress">
						{#if preloadPercent === null}
							<Spinner />
							<p class="hint">Starting the download…</p>
						{:else}
							<ProgressBar
								value={preloadPercent / 100}
								color="var(--accent)"
								label="Voice model download progress"
							/>
							<p class="hint">{preloadPercent}% downloaded</p>
						{/if}
					</div>
				{/if}
			{/if}
		</section>

		<section class="card">
			<h2>Language model</h2>

			<div class="field">
				<span class="label">OpenRouter API key</span>
				<input
					class="input"
					type="password"
					bind:value={apiKeyInput}
					placeholder={apiKeySet ? '••• saved' : 'sk-or-v1-...'}
					autocomplete="off"
					spellcheck="false"
				/>
				<p class="hint">Stored only in your browser — it never leaves this device except to call OpenRouter.</p>
			</div>
			<div class="actions-row">
				<button type="button" class="btn btn-primary" onclick={saveKey}>Save key</button>
				{#if apiKeySet}
					<button type="button" class="btn btn-ghost" onclick={clearKey}>Clear key</button>
				{/if}
				<InlineStatus status={apiKeyStatus} message={apiKeyMessage} />
			</div>

			<div class="field model-field">
				<span class="label">Model</span>
				<input
					class="input"
					list="settings-models"
					bind:value={modelInput}
					placeholder={DEFAULT_MODEL}
					autocomplete="off"
					spellcheck="false"
				/>
				<datalist id="settings-models">
					{#each MODEL_SUGGESTIONS as suggestion (suggestion)}
						<option value={suggestion}></option>
					{/each}
				</datalist>
				<p class="hint">Any OpenRouter model id works — pick a suggestion or type your own.</p>
			</div>
			<div class="actions-row">
				<button type="button" class="btn btn-primary" onclick={saveModelChoice}>Save model</button>
				<InlineStatus status={modelStatus} message={modelMessage} />
			</div>
		</section>

		<section class="card">
			<h2>Usage</h2>
			<dl class="usage-grid">
				<div class="usage-item">
					<dt>Requests</dt>
					<dd>{usageRequests.toLocaleString()}</dd>
				</div>
				<div class="usage-item">
					<dt>Prompt tokens</dt>
					<dd>{usagePromptTokens.toLocaleString()}</dd>
				</div>
				<div class="usage-item">
					<dt>Completion tokens</dt>
					<dd>{usageCompletionTokens.toLocaleString()}</dd>
				</div>
			</dl>
			<p class="hint">Actual cost depends on the model you've chosen above.</p>
		</section>

		<section class="card">
			<h2>Data</h2>
			<div class="actions-row">
				<button type="button" class="btn btn-primary" onclick={handleExport}>
					Export progress
				</button>
				<InlineStatus status={exportStatus} message={exportMessage} />
			</div>

			<div class="field import-field">
				<span class="label">Import progress</span>
				<input
					class="input"
					type="file"
					accept="application/json"
					onchange={handleImportChange}
					disabled={importing}
				/>
				<p class="hint">Replaces all current progress on this device with the backup's contents.</p>
			</div>
			<InlineStatus status={importStatus} message={importMessage} />
		</section>

		<section class="card danger-card">
			<h2>Danger zone</h2>
			<p class="hint">
				Permanently deletes every word, review, and stat on this device. This cannot be undone.
			</p>

			{#if resetStage === 'idle'}
				<button type="button" class="btn danger-btn" onclick={startReset}>
					Reset all progress
				</button>
			{:else}
				<div class="reset-confirm">
					<label class="field" for="reset-confirm-input">
						<span class="label">Type RESET to confirm</span>
						<input
							id="reset-confirm-input"
							class="input"
							bind:value={resetInput}
							autocomplete="off"
							spellcheck="false"
						/>
					</label>
					<div class="actions-row">
						<button
							type="button"
							class="btn danger-btn"
							disabled={resetInput.trim().toUpperCase() !== 'RESET' || resetting}
							onclick={confirmReset}
						>
							{resetting ? 'Resetting…' : 'Confirm reset'}
						</button>
						<button type="button" class="btn btn-ghost" onclick={cancelReset} disabled={resetting}>
							Cancel
						</button>
					</div>
					{#if resetError}
						<p class="error" role="alert">{resetError}</p>
					{/if}
				</div>
			{/if}
		</section>
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

	.topbar {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.back {
		color: var(--text-muted);
		text-decoration: none;
		font-weight: 800;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.4rem;
	}

	.card {
		max-width: none;
	}

	.card h2 {
		margin: 0 0 1rem;
		font-size: 1.1rem;
	}

	.readonly-row {
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		margin: 0 0 0.5rem;
		font-size: 0.95rem;
	}

	.readonly-label {
		color: var(--text-muted);
		font-weight: 700;
	}

	.readonly-value.capitalize {
		text-transform: capitalize;
	}

	.muted {
		color: var(--text-muted);
		font-weight: 400;
	}

	.preset-row {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}

	.chip {
		padding: 0.4rem 0.85rem;
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

	.chip.selected {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--text);
	}

	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.switch-copy {
		min-width: 0;
	}

	.switch-copy .label {
		display: block;
		margin-bottom: 0.3rem;
	}

	.switch-copy .hint {
		margin: 0;
	}

	.switch {
		flex: 0 0 auto;
		position: relative;
		width: 3rem;
		height: 1.75rem;
		padding: 0;
		border: 2px solid var(--border);
		border-radius: 999px;
		background: var(--surface-alt);
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease;
	}

	.switch:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.switch.on {
		border-color: var(--primary);
		background: var(--primary);
	}

	.switch-thumb {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 999px;
		background: var(--surface);
		box-shadow: 0 1px 3px rgb(16 24 40 / 20%);
		transition: transform 0.15s ease;
	}

	.switch.on .switch-thumb {
		transform: translateX(1.25rem);
	}

	.preload-progress {
		margin-top: 0.9rem;
	}

	.test-bench-link {
		margin: -0.5rem 0 1rem;
	}

	.test-bench-link a {
		color: var(--primary-strong);
		font-weight: 700;
		text-decoration: none;
	}

	.test-bench-link a:hover {
		text-decoration: underline;
	}

	.model-field {
		margin-top: 1.25rem;
	}

	.import-field {
		margin-top: 1.25rem;
		margin-bottom: 0.5rem;
	}

	.actions-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.usage-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.75rem;
		margin: 0 0 0.75rem;
	}

	.usage-item {
		padding: 0.75rem;
		border-radius: var(--radius);
		background: var(--surface-alt);
		text-align: center;
	}

	.usage-item dt {
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.usage-item dd {
		margin: 0.2rem 0 0;
		font-size: 1.2rem;
		font-weight: 800;
	}

	.danger-card {
		border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
	}

	.danger-btn {
		background: var(--danger);
		color: var(--text-inverse);
	}

	.reset-confirm {
		margin-top: 0.75rem;
	}

	.error {
		margin: 0.75rem 0 0;
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		font-weight: 700;
	}

	@media (max-width: 480px) {
		.usage-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
