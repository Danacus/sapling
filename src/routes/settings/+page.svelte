<script lang="ts">
	import { browser } from '$app/environment';

	import {
		db,
		DEFAULT_MODEL,
		exportData,
		getAllItems,
		getApiKey,
		getBaseUrl,
		getModel,
		getProfile,
		getSyncState,
		importData,
		outboxCount,
		saveProfile,
		setApiKey,
		setBaseUrl,
		setModel,
		upsertItems
	} from '$lib/db';
	import { fillRomanizations, isMockMode } from '$lib/llm';
	import {
		audioCacheBytes,
		AUDIO_CACHE_MAX_BYTES,
		clearAudioCache,
		formatCacheSize,
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
	import { clearSyncConfig, getSyncKey, getSyncServer, setSyncKey, setSyncServer, syncEnabled } from '$lib/sync/config';
	import { runSync } from '$lib/sync/run';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import InlineStatus from '$lib/ui/InlineStatus.svelte';
	import {
		getListeningMode,
		getRomanizationMode,
		setListeningMode,
		setRomanizationMode,
		type RomanizationMode
	} from '$lib/ui/prefs';
	import ProgressBar from '$lib/ui/ProgressBar.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	type Status = 'idle' | 'saved' | 'error';

	const GOAL_PRESETS = [30, 60, 120];
	const MODEL_SUGGESTIONS = [
		'google/gemini-3.7-flash',
		'google/gemini-3.5-flash-lite',
		'google/gemini-3.1-flash-lite',
		'openai/gpt-5-nano',
		'anthropic/claude-haiku-4.5',
		'Qwen/Qwen3.6-35B-A3B-FP8'
	];
	const ROMANIZATION_MODES: { value: RomanizationMode; label: string }[] = [
		{ value: 'off', label: 'Off' },
		{ value: 'on', label: 'On' },
		{ value: 'adaptive', label: 'Adaptive' }
	];

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let allItems = $state<KnowledgeItem[]>([]);
	/** No key configured (or the flag is set): nothing here may offer to spend. */
	let mockMode = $state(false);

	// Profile / goal ------------------------------------------------------------
	let dailyGoalXp = $state(60);
	let savingGoal = $state(false);
	let goalStatus = $state<Status>('idle');
	let goalMessage = $state('');

	// Display -----------------------------------------------------------------------
	let romanizationMode = $state<RomanizationMode>('on');
	let listeningMode = $state(true);

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
	/** Stored spoken clips, in bytes. 0 until the first read comes back. */
	let audioBytes = $state(0);
	let clearingAudio = $state(false);
	let audioCacheStatus = $state<Status>('idle');
	let audioCacheMessage = $state('');

	// LLM: endpoint + key + model, applied together ---------------------------------
	let baseUrlInput = $state('');
	let apiKeySet = $state(false);
	let apiKeyInput = $state('');
	let modelInput = $state(DEFAULT_MODEL);
	let llmStatus = $state<Status>('idle');
	let llmMessage = $state('');

	// Sync --------------------------------------------------------------------------
	let syncServerInput = $state('');
	let syncKeyInput = $state('');
	/** Whether a key is currently saved — the input itself stays blank, like the API key field. */
	let syncKeySet = $state(false);
	let syncConfigured = $state(false);
	let syncConfigStatus = $state<Status>('idle');
	let syncConfigMessage = $state('');
	let syncing = $state(false);
	let syncStatus = $state<Status>('idle');
	let syncMessage = $state('');
	let lastSyncAt = $state<number | undefined>(undefined);
	let pendingOutbox = $state(0);

	// Usage -------------------------------------------------------------------------
	let usagePromptTokens = $state(0);
	let usageCompletionTokens = $state(0);
	let usageRequests = $state(0);

	// Readings backfill -------------------------------------------------------------
	let backfilling = $state(false);
	let backfillStatus = $state<Status>('idle');
	let backfillMessage = $state('');

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

		Promise.all([getProfile(), getAllItems()])
			.then(([loadedProfile, loadedItems]) => {
				if (cancelled) return;
				profile = loadedProfile;
				allItems = loadedItems;
				dailyGoalXp = loadedProfile?.dailyGoalXp ?? 60;

				mockMode = isMockMode();
				apiKeySet = getApiKey() !== undefined;
				modelInput = getModel();
				baseUrlInput = getBaseUrl() ?? '';
				romanizationMode = getRomanizationMode();
				listeningMode = getListeningMode();

				ttsEngine = getTtsEngine();
				ttsVoice = getTtsVoice();

				syncServerInput = getSyncServer() ?? '';
				syncKeySet = getSyncKey() !== undefined;
				syncConfigured = syncEnabled();
				// Best-effort, like the audio cache size below — must not hold up the page.
				void refreshSyncStatus();
				// Walks Cache Storage, so it must not hold up the rest of the page;
				// it reports 0 rather than failing if the cache is unreachable.
				void audioCacheBytes().then((bytes) => {
					if (!cancelled) audioBytes = bytes;
				});

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

	/** e.g. "37 MB of 105 MB" — both halves come from the cache module. */
	const audioCacheSize = $derived(formatCacheSize(audioBytes));
	const audioCacheCap = formatCacheSize(AUDIO_CACHE_MAX_BYTES);

	const lastSyncLabel = $derived(formatLastSync(lastSyncAt));

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

	function toggleListeningMode() {
		listeningMode = !listeningMode;
		setListeningMode(listeningMode);
	}

	function setRomanization(mode: RomanizationMode) {
		romanizationMode = mode;
		setRomanizationMode(mode);
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

	/**
	 * Throws away the stored clips. Only the clip bucket — the voice model is a
	 * separate cache, and nobody wants a stray tap to cost them that download.
	 */
	async function clearAudioClips() {
		if (clearingAudio) return;
		clearingAudio = true;
		audioCacheStatus = 'idle';
		try {
			await clearAudioCache();
			audioBytes = await audioCacheBytes();
			audioCacheMessage = 'Audio cache cleared';
			flash((value) => (audioCacheStatus = value));
		} catch (cause) {
			audioCacheMessage =
				cause instanceof Error ? cause.message : 'Could not clear the audio cache.';
			audioCacheStatus = 'error';
		} finally {
			clearingAudio = false;
		}
	}

	/** Applies endpoint, key and model at once. A blank key keeps the saved one. */
	function applyLlmSettings() {
		try {
			setBaseUrl(baseUrlInput);
			baseUrlInput = getBaseUrl() ?? '';
			const key = apiKeyInput.trim();
			if (key) {
				setApiKey(key);
				apiKeySet = true;
				apiKeyInput = '';
			}
			setModel(modelInput);
			modelInput = getModel();
			mockMode = isMockMode();
			llmMessage = 'Saved';
			flash((value) => (llmStatus = value));
		} catch (cause) {
			llmMessage = cause instanceof Error ? cause.message : 'Could not save.';
			llmStatus = 'error';
		}
	}

	/** Refreshes the status line. Best-effort — a failed read leaves the previous values on screen. */
	async function refreshSyncStatus(): Promise<void> {
		try {
			const [last, pending] = await Promise.all([getSyncState<number>('lastSync'), outboxCount()]);
			lastSyncAt = last;
			pendingOutbox = pending;
		} catch {
			/* ignore: status is best-effort */
		}
	}

	/**
	 * Saves the server URL and, if one was typed, the key. The key input mirrors
	 * the OpenRouter field: it starts blank and stays blank after a save, so a
	 * saved key is never redisplayed. Leaving it blank on a later save keeps the
	 * key that's already there — only "Turn off sync" clears both together.
	 */
	function saveSyncConfig(): void {
		const server = syncServerInput.trim();
		const key = syncKeyInput.trim();
		if (!server || (!key && !syncKeySet)) {
			syncConfigMessage = 'Enter both a server URL and an API key.';
			syncConfigStatus = 'error';
			return;
		}
		try {
			setSyncServer(server);
			if (key) setSyncKey(key);
			syncServerInput = getSyncServer() ?? '';
			syncKeyInput = '';
			syncKeySet = getSyncKey() !== undefined;
			syncConfigured = syncEnabled();
			syncConfigMessage = 'Sync settings saved';
			flash((value) => (syncConfigStatus = value));
			void refreshSyncStatus();
		} catch (cause) {
			syncConfigMessage = cause instanceof Error ? cause.message : 'Could not save sync settings.';
			syncConfigStatus = 'error';
		}
	}

	function turnOffSync(): void {
		clearSyncConfig();
		syncServerInput = '';
		syncKeyInput = '';
		syncKeySet = false;
		syncConfigured = false;
		syncConfigMessage = 'Sync turned off';
		flash((value) => (syncConfigStatus = value));
	}

	/** Runs one sync cycle and reports the outcome; `runSync` itself never throws. */
	async function syncNow(): Promise<void> {
		if (syncing) return;
		syncing = true;
		syncStatus = 'idle';
		syncMessage = '';
		try {
			const outcome = await runSync();
			if (outcome.skipped) {
				syncMessage = 'Add a sync server and key above first.';
				syncStatus = 'error';
			} else if (outcome.ok) {
				syncMessage = `Synced — ${outcome.pushed} pushed, ${outcome.pulled} pulled`;
				flash((value) => (syncStatus = value), 3000);
			} else {
				syncMessage = outcome.error ?? 'Sync failed.';
				syncStatus = 'error';
			}
		} finally {
			syncing = false;
			void refreshSyncStatus();
		}
	}

	/** e.g. "3 minutes ago" — falls back to a locale timestamp past a week. */
	function formatLastSync(at: number | undefined): string {
		if (at === undefined) return 'never';
		const deltaMs = Date.now() - at;
		const minute = 60_000;
		const hour = 3_600_000;
		const day = 86_400_000;
		if (deltaMs < minute) return 'just now';
		if (deltaMs < hour) {
			const mins = Math.round(deltaMs / minute);
			return `${mins} minute${mins === 1 ? '' : 's'} ago`;
		}
		if (deltaMs < day) {
			const hours = Math.round(deltaMs / hour);
			return `${hours} hour${hours === 1 ? '' : 's'} ago`;
		}
		if (deltaMs < 7 * day) {
			const days = Math.round(deltaMs / day);
			return `${days} day${days === 1 ? '' : 's'} ago`;
		}
		return new Date(at).toLocaleString();
	}

	/**
	 * Whether a word is unreadable without help: it has no stored reading, and
	 * what is left of its term once every Latin letter is removed still contains
	 * a letter. That second half is the whole test — "café" and "Straße" strip
	 * down to nothing and are left alone, "菜单" and "ありがとう" do not.
	 * Punctuation and digits are not letters, so they never trigger it either.
	 */
	function needsReading(item: KnowledgeItem): boolean {
		if (item.romanization?.trim()) return false;
		return /\p{L}/u.test(item.term.replace(/\p{Script=Latin}/gu, ''));
	}

	/**
	 * Words that predate romanization support. Only worth offering when there is
	 * a real key behind it — the mock has no readings to give, and this is the
	 * one button in the app that spends tokens on something other than a lesson.
	 */
	const missingReadings = $derived(allItems.filter(needsReading));

	/** Backfills readings for every unreadable word in one batched call. */
	async function backfillReadings() {
		if (backfilling || !profile) return;
		backfilling = true;
		backfillStatus = 'idle';
		backfillMessage = '';

		const targets = missingReadings;
		try {
			const { readings } = await fillRomanizations({
				items: targets.map((item) => ({ id: item.id, term: item.term })),
				targetLanguage: profile.targetLanguage
			});

			const patched = targets
				.filter((item) => readings.has(item.id))
				.map((item) => ({ ...item, romanization: readings.get(item.id) as string }));
			await upsertItems(patched);

			// Patch the local copy rather than re-reading: the count in the button
			// label has to fall the moment the write lands.
			const byId = new Map(patched.map((item) => [item.id, item]));
			allItems = allItems.map((item) => byId.get(item.id) ?? item);

			if (patched.length === 0) {
				backfillMessage = 'The model returned no usable readings.';
				backfillStatus = 'error';
			} else {
				backfillMessage = `Added ${patched.length} reading${patched.length === 1 ? '' : 's'}`;
				flash((value) => (backfillStatus = value), 3000);
			}
		} catch (cause) {
			backfillMessage = cause instanceof Error ? cause.message : 'Could not fetch the readings.';
			backfillStatus = 'error';
		} finally {
			backfilling = false;
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
	<header class="topbar ll-rise">
		<a class="back" href="/" aria-label="Back to home">
			<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
				<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
			</svg>
		</a>
		<div class="identity">
			<p class="eyebrow">Sapling</p>
			<h1>Settings</h1>
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
					<circle cx="12" cy="8.4" r="3.4" />
					<path d="M4.9 19.6c.7-3.4 3.5-5.5 7.1-5.5s6.4 2.1 7.1 5.5" />
				</svg>
				<h2>Profile</h2>
			</div>
			<hr class="stitch" />
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
				<!--
				  Read-only on purpose: level, interests and the self-description are
				  edited in one place (/profile) so there is never a second copy of
				  that form to keep in step with this one.
				-->
				<p class="hint profile-link">
					<a href="/profile">
						Edit level, interests and about you
						<svg class="ico jump-ico" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M4.8 12h14" />
							<path d="m13.4 6.6 5.4 5.4-5.4 5.4" />
						</svg>
					</a>
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

		<section class="card ll-rise" style="animation-delay: 110ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M2.9 12S6.7 6.4 12 6.4 21.1 12 21.1 12 17.3 17.6 12 17.6 2.9 12 2.9 12Z" />
					<circle cx="12" cy="12" r="2.6" />
				</svg>
				<h2>Display</h2>
			</div>
			<hr class="stitch" />
			<div class="field">
				<span class="label">Pronunciation (romanization)</span>
				<p class="hint">
					Pinyin, romaji and the like under words written in a non-Latin script. Only shows up for
					languages that need it. Adaptive hides the reading for words you know well, so the crutch
					fades as a word sticks.
				</p>
				<div class="preset-row" role="group" aria-label="Pronunciation (romanization)">
					{#each ROMANIZATION_MODES as option (option.value)}
						<button
							type="button"
							class="chip"
							class:selected={romanizationMode === option.value}
							aria-pressed={romanizationMode === option.value}
							onclick={() => setRomanization(option.value)}
						>
							{option.label}
						</button>
					{/each}
				</div>
			</div>

			<div class="switch-row">
				<div class="switch-copy">
					<span class="label">Listening challenges</span>
					<p class="hint">
						Some "what does this mean?" challenges are played instead of shown, with the text one tap
						away. Needs speech to be on; turn this off to always see the words.
					</p>
				</div>
				<button
					type="button"
					class="switch"
					class:on={listeningMode}
					role="switch"
					aria-checked={listeningMode}
					aria-label="Listening challenges"
					onclick={toggleListeningMode}
				>
					<span class="switch-thumb"></span>
				</button>
			</div>
		</section>

		<section class="card ll-rise" style="animation-delay: 160ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.6 9.6h3.1L12 6.1v11.8l-4.3-3.5H4.6Z" />
					<path d="M15.6 9.7a3.4 3.4 0 0 1 0 4.6" />
					<path d="M18.1 7.4a6.7 6.7 0 0 1 0 9.2" />
				</svg>
				<h2>Speech</h2>
			</div>
			<hr class="stitch" />
			<p class="hint test-bench-link">
				<a href="/tts-test">
					Test voices
					<svg class="ico jump-ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="M4.8 12h14" />
						<path d="m13.4 6.6 5.4 5.4-5.4 5.4" />
					</svg>
				</a>
			</p>

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
					Synthesis takes roughly a second or two per phrase on a laptop CPU, in a background thread.
					Each clip is then kept, so a word you have heard before plays back instantly — including
					after a reload.
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

			<!--
			  Outside the Kokoro block on purpose: only Kokoro fills this cache, but
			  someone who has just switched to the browser voice is exactly the
			  person who wants to reclaim the space.
			-->
			<div class="field">
				<span class="label">Audio cache</span>
				<p class="hint">
					{audioCacheSize} of spoken clips, out of {audioCacheCap}. Stored in your browser alongside
					the voice model; once it is full the clips you have not played in longest are dropped.
					Clearing them costs nothing but a moment's re-synthesis — the {downloadSize} voice model is
					a separate cache and stays put.
				</p>
				<div class="actions-row">
					<button
						type="button"
						class="btn btn-ghost"
						onclick={() => void clearAudioClips()}
						disabled={clearingAudio || audioBytes === 0}
					>
						{clearingAudio ? 'Clearing…' : 'Clear audio cache'}
					</button>
					<InlineStatus status={audioCacheStatus} message={audioCacheMessage} />
				</div>
			</div>
		</section>

		<section class="card ll-rise" style="animation-delay: 200ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="7.2" cy="12" r="3.9" />
					<path d="M11.1 12h9.3" />
					<path d="M17.2 12v3.3" />
					<path d="M20.4 12v2.3" />
				</svg>
				<h2>Language model</h2>
			</div>
			<hr class="stitch" />

			<div class="field">
				<span class="label">API endpoint</span>
				<input
					class="input"
					type="url"
					bind:value={baseUrlInput}
					placeholder="https://openrouter.ai/api/v1"
					autocomplete="off"
					spellcheck="false"
				/>
			</div>
			<div class="field">
				<span class="label">API key</span>
				<input
					class="input"
					type="password"
					bind:value={apiKeyInput}
					placeholder={apiKeySet ? '••• saved' : 'sk-or-v1-...'}
					autocomplete="off"
					spellcheck="false"
				/>
			</div>
			<div class="field">
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
			</div>
			<p class="hint">
				Any OpenAI-compatible endpoint; blank means OpenRouter. The key stays in this browser.
			</p>
			<div class="actions-row">
				<button type="button" class="btn btn-primary" onclick={applyLlmSettings}>Apply</button>
				<InlineStatus status={llmStatus} message={llmMessage} />
			</div>
		</section>

		<section class="card ll-rise" style="animation-delay: 200ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M19.6 11.2A7.8 7.8 0 0 0 6.4 6.6L4.2 8.8" />
					<path d="M4.4 12.8a7.8 7.8 0 0 0 13.2 4.6l2.2-2.2" />
					<path d="M4.2 4.6v4.2h4.2" />
					<path d="M19.8 19.4v-4.2h-4.2" />
				</svg>
				<h2>Sync</h2>
			</div>
			<hr class="stitch" />
			<p class="hint">
				When sync is on, your vocabulary, challenge content, review history, results, XP days and
				profile (including your About text) sync to your own server. Your OpenRouter key, this
				sync key, preferences and TTS caches never leave this device.
			</p>

			<div class="field">
				<span class="label">Sync server URL</span>
				<input
					class="input"
					type="text"
					bind:value={syncServerInput}
					placeholder="https://sync.example.com"
					autocomplete="off"
					spellcheck="false"
				/>
			</div>

			<div class="field sync-key-field">
				<span class="label">Sync API key</span>
				<input
					class="input"
					type="password"
					bind:value={syncKeyInput}
					placeholder={syncKeySet ? '••• saved' : 'from your server operator'}
					autocomplete="off"
					spellcheck="false"
				/>
			</div>

			<div class="actions-row">
				<button type="button" class="btn btn-primary" onclick={saveSyncConfig}>
					Save sync settings
				</button>
				{#if syncConfigured}
					<button type="button" class="btn btn-ghost" onclick={turnOffSync}>Turn off sync</button>
				{/if}
				<InlineStatus status={syncConfigStatus} message={syncConfigMessage} />
			</div>

			{#if syncConfigured}
				<p class="hint sync-status-line">
					Last synced {lastSyncLabel} · {pendingOutbox} pending event{pendingOutbox === 1 ? '' : 's'}
				</p>
			{/if}

			<div class="actions-row sync-now-row">
				<button
					type="button"
					class="btn btn-primary"
					onclick={() => void syncNow()}
					disabled={syncing}
				>
					{syncing ? 'Syncing…' : 'Sync now'}
				</button>
				<InlineStatus status={syncStatus} message={syncMessage} />
			</div>
		</section>

		<section class="card ll-rise" style="animation-delay: 200ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.4 19.4h15.2" />
					<path d="M8 19.4v-5.6" />
					<path d="M12 19.4V8.2" />
					<path d="M16 19.4v-3.4" />
				</svg>
				<h2>Usage</h2>
			</div>
			<hr class="stitch" />
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

		<section class="card ll-rise" style="animation-delay: 200ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M4.6 8.4h14.8v9.6a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4Z" />
					<path d="M3.6 5.2h16.8v3.2H3.6Z" />
					<path d="M10.2 12h3.6" />
				</svg>
				<h2>Data</h2>
			</div>
			<hr class="stitch" />
			<div class="actions-row">
				<button type="button" class="btn btn-primary" onclick={handleExport}>
					Export progress
				</button>
				<InlineStatus status={exportStatus} message={exportMessage} />
			</div>

			{#if !mockMode && missingReadings.length > 0}
				<div class="field backfill-field">
					<span class="label">Missing pronunciations</span>
					<p class="hint">
						{missingReadings.length} word{missingReadings.length === 1 ? '' : 's'} from before pronunciations
						were supported {missingReadings.length === 1 ? 'has' : 'have'} no reading. One short model call
						fills them all in.
					</p>
					<div class="actions-row">
						<button
							type="button"
							class="btn btn-primary"
							onclick={() => void backfillReadings()}
							disabled={backfilling}
						>
							{backfilling ? 'Fetching…' : `Add missing readings (${missingReadings.length})`}
						</button>
						<InlineStatus status={backfillStatus} message={backfillMessage} />
					</div>
				</div>
			{/if}

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

		<section class="card danger-card ll-rise" style="animation-delay: 200ms">
			<div class="card-head">
				<svg class="ico head-ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="M12 4.4 21 19.6H3Z" />
					<path d="M12 10.2v4" />
					<path d="M12 17.1h.01" />
				</svg>
				<h2>Danger zone</h2>
			</div>
			<hr class="stitch" />
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

	/* The same 2.25rem squircle the dashboard's topbar controls wear, so the
	   way back looks like the way out rather than a stray link. */
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

	/* Each section is headed like a pressed specimen: its mark on tinted paper
	   inside a dashed frame, then the app's stitched rule under the heading. */
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

	/* Ruled ledger rows: the fact on the left, its value on the right, the same
	   hairline between them the word list uses. */
	.readonly-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		margin: 0;
		padding: 0.5rem 0;
		font-size: 0.95rem;
	}

	.readonly-row + .readonly-row {
		border-top: 1px solid var(--border);
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
		padding: 0.35rem 0.8rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.83rem;
		font-weight: 500;
		font-variant-numeric: tabular-nums;
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
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--text);
		font-weight: 700;
	}

	.chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.switch-copy {
		min-width: 0;
	}

	/* Not a direct child of `.field`, so it does not inherit the global label
	   rule — matched here so every label on the page reads the same. */
	.switch-copy .label {
		display: block;
		margin-bottom: 0.3rem;
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.switch-copy .hint {
		margin: 0;
	}

	/* A slider on a ruled track rather than a plastic pill: hairline frame, the
	   same squared radius as the inputs, and a thumb that reads as a paper tab. */
	.switch {
		flex: 0 0 auto;
		position: relative;
		width: 3rem;
		height: 1.75rem;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
		box-shadow: inset 0 1px 2px rgb(60 50 20 / 8%);
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
		border-color: var(--primary-strong);
		background: var(--primary);
	}

	.switch-thumb {
		position: absolute;
		top: 0.15rem;
		left: 0.15rem;
		width: 1.3rem;
		height: 1.3rem;
		border-radius: 4px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		transition: transform 0.16s cubic-bezier(0.2, 0.7, 0.3, 1);
	}

	.switch.on .switch-thumb {
		border-color: var(--primary-strong);
		transform: translateX(1.28rem);
	}

	@media (prefers-reduced-motion: reduce) {
		.switch-thumb {
			transition: none;
		}
	}

	.preload-progress {
		margin-top: 0.9rem;
	}

	.test-bench-link {
		margin: 0 0 1.15rem;
	}

	.profile-link {
		margin: 0.85rem 0 0;
	}

	.profile-link a,
	.test-bench-link a {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: var(--primary-strong);
		font-weight: 700;
		text-decoration: none;
	}

	.profile-link a:hover,
	.test-bench-link a:hover {
		text-decoration: underline;
	}

	/* The arrow leans into the walk on hover — the only movement on the page. */
	.jump-ico {
		width: 0.95rem;
		height: 0.95rem;
		transition: transform 0.15s ease;
	}

	.profile-link a:hover .jump-ico,
	.test-bench-link a:hover .jump-ico {
		transform: translateX(2px);
	}

	@media (prefers-reduced-motion: reduce) {
		.jump-ico {
			transition: none;
		}
	}

	.sync-key-field {
		margin-top: 1.25rem;
	}

	.sync-status-line {
		margin: 0.9rem 0 0;
	}

	.sync-now-row {
		margin-top: 0.9rem;
	}

	.backfill-field {
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

	/* A tally sheet rather than three tiles: the figure is the thing worth
	   reading, set in the display face with tabular numerals so the column of
	   counts lines up. */
	.usage-grid {
		margin: 0 0 0.85rem;
	}

	.usage-item {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.5rem 0;
	}

	.usage-item + .usage-item {
		border-top: 1px solid var(--border);
	}

	.usage-item dt {
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.usage-item dd {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		font-variant-numeric: tabular-nums;
	}

	/* Native selects keep the `.input` frame; only the marker is ours — two
	   gradient halves, so the caret follows the ink colour in either theme. */
	select.input {
		appearance: none;
		padding-right: 2.2rem;
		background-image:
			linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
			linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
		background-position:
			right 1.15rem center,
			right 0.85rem center;
		background-size: 0.32rem 0.32rem;
		background-repeat: no-repeat;
	}

	/* The file picker's own button, dressed as one of ours. */
	input[type='file'].input {
		padding: 0.5rem 0.6rem;
		font-size: 0.9rem;
	}

	input[type='file'].input::file-selector-button {
		margin-right: 0.7rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface-alt);
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
	}

	.danger-card {
		border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
	}

	.danger-card .head-ico {
		border-color: color-mix(in srgb, var(--danger) 40%, var(--border-strong));
		background: color-mix(in srgb, var(--danger) 8%, transparent);
		color: var(--danger);
	}

	/* Stamped in red ink rather than filled: destructive, but it does not want
	   to be the brightest thing on a page of calm paper. */
	.danger-btn {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	.danger-btn:hover:not(:disabled) {
		border-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 20%, transparent);
		filter: none;
	}

	.reset-confirm {
		margin-top: 0.85rem;
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
