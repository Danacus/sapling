<script lang="ts">
	/**
	 * Speech test bench: a tiny standalone page to poke at `$lib/tts` with
	 * arbitrary text and languages without going through a real lesson. Single
	 * user, no persistence beyond what the TTS module itself already persists
	 * (engine + Mandarin voice prefs) — this page is a scratch surface, not a
	 * feature.
	 */
	import { browser } from '$app/environment';

	import { getProfile } from '$lib/db';
	import {
		isMandarin,
		getTtsEngine,
		getTtsVoice,
		kokoroSupports,
		MANDARIN_SPEAKERS,
		onSherpaProgress,
		setTtsVoice,
		speak,
		stopSpeaking,
		ttsAvailable,
		type TtsEngine,
		type TtsVoice
	} from '$lib/tts';
	import type { Profile } from '$lib/types';

	const CHINESE_SAMPLE = '你好，我想买三个苹果。';
	const ENGLISH_SAMPLE = "Hello, I'd like three apples, please.";

	type Status = 'idle' | 'loading' | 'working' | 'done' | 'error';

	let loading = $state(true);
	let profile = $state<Profile | undefined>(undefined);

	let text = $state(ENGLISH_SAMPLE);
	let language = $state('');

	// Mirrors Settings — same storage keys, so a change here shows up there too.
	let ttsEngine = $state<TtsEngine>('kokoro');
	let ttsVoice = $state<TtsVoice>('auto');

	let status = $state<Status>('idle');
	/** 0-100 while Kokoro's model is downloading, else `null`. */
	let loadingPercent = $state<number | null>(null);
	let elapsedSeconds = $state<number | null>(null);
	let errorMessage = $state('');
	let speaking = $state(false);
	/** Distinguishes a manual Stop from natural completion once the awaited call returns. */
	let stoppedManually = false;

	$effect(() => {
		if (!browser) return;
		let cancelled = false;

		getProfile()
			.then((loadedProfile) => {
				if (cancelled) return;
				profile = loadedProfile;
				if (loadedProfile?.targetLanguage) {
					language = loadedProfile.targetLanguage;
					if (isMandarin(loadedProfile.targetLanguage)) {
						text = CHINESE_SAMPLE;
					}
				}
				ttsEngine = getTtsEngine();
				ttsVoice = getTtsVoice();
				loading = false;
			})
			.catch(() => {
				if (cancelled) return;
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/** "Chinese", "English", plus the profile's own target language if it's a third thing. */
	const chips = $derived.by(() => {
		const list = ['Chinese', 'English'];
		const target = profile?.targetLanguage?.trim();
		if (target && !list.some((name) => name.toLowerCase() === target.toLowerCase())) {
			list.push(target);
		}
		return list;
	});

	// Mandarin voice only ever applies to Mandarin (see kokoroSpeakerFor) — no
	// point showing the picker for a language it can't affect.
	const showVoicePicker = $derived(ttsEngine === 'kokoro' && isMandarin(language));

	const engineLabel = $derived.by(() => {
		if (ttsEngine === 'off') return 'Off';
		if (ttsEngine === 'kokoro' && kokoroSupports(language)) return 'Kokoro (neural)';
		return 'Browser built-in';
	});

	const available = $derived(ttsAvailable(language));

	function chooseVoice(voice: TtsVoice) {
		ttsVoice = voice;
		setTtsVoice(voice);
	}

	function pickLanguage(chip: string) {
		language = chip;
	}

	async function handleSpeak() {
		const phrase = text.trim();
		if (!phrase || speaking) return;

		speaking = true;
		stoppedManually = false;
		status = 'working';
		loadingPercent = null;
		elapsedSeconds = null;
		errorMessage = '';

		const start = performance.now();
		// Fires only while Kokoro's model is actually downloading; a warm engine
		// (or a call that never touches Kokoro) never triggers this, and the
		// status line just stays on "Synthesizing…" until the promise settles.
		const unsubscribe = onSherpaProgress((progress) => {
			status = 'loading';
			loadingPercent = Math.round(progress.progress);
		});

		try {
			await speak(phrase, language);
			if (stoppedManually) {
				status = 'idle';
			} else {
				elapsedSeconds = Math.round((performance.now() - start) / 100) / 10;
				status = 'done';
			}
		} catch (cause) {
			// speak() resolves quietly on every failure path it knows about; this
			// is belt-and-braces for anything unforeseen.
			errorMessage = cause instanceof Error ? cause.message : 'Something went wrong.';
			status = 'error';
		} finally {
			unsubscribe();
			speaking = false;
		}
	}

	function handleStop() {
		stoppedManually = true;
		stopSpeaking();
	}
</script>

<svelte:head>
	<title>Speech test bench</title>
</svelte:head>

<main class="shell">
	<section class="card">
		<a class="back" href="/settings">
			<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
				<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
			</svg>
			Back to Settings
		</a>
		<h1>Speech test bench</h1>
		<hr class="stitch" />

		{#if loading}
			<p class="hint">Loading your profile…</p>
		{/if}

		<div class="field">
			<span class="label" id="tts-text-label">Text</span>
			<textarea
				class="input"
				id="tts-text"
				aria-labelledby="tts-text-label"
				rows="4"
				bind:value={text}></textarea>
		</div>

		<div class="field">
			<span class="label" id="tts-lang-label">Language</span>
			<input
				class="input"
				id="tts-lang"
				aria-labelledby="tts-lang-label"
				bind:value={language}
				placeholder="e.g. Spanish"
				autocomplete="off"
				spellcheck="false"
			/>
			<div class="chip-row">
				{#each chips as chip (chip)}
					<button
						type="button"
						class="chip"
						class:selected={chip.toLowerCase() === language.trim().toLowerCase()}
						onclick={() => pickLanguage(chip)}
					>
						{chip}
					</button>
				{/each}
			</div>
			<p class="hint">
				Will use: {engineLabel}{available ? '' : ' — not available right now'}
			</p>
		</div>

		{#if showVoicePicker}
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
				<p class="hint">Same preference as Settings — changing it here persists app-wide.</p>
			</div>
		{/if}

		<div class="actions-row">
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void handleSpeak()}
				disabled={speaking || !text.trim()}
			>
				{speaking ? 'Working…' : 'Speak'}
			</button>
			<button type="button" class="btn btn-ghost" onclick={handleStop} disabled={!speaking}>
				Stop
			</button>
		</div>

		<p class="status-line" role="status">
			{#if status === 'idle'}
				Idle.
			{:else if status === 'loading'}
				Loading voice model{loadingPercent !== null ? ` — ${loadingPercent}%` : '…'}
			{:else if status === 'working'}
				Synthesizing…
			{:else if status === 'done'}
				Done{elapsedSeconds !== null ? ` — ${elapsedSeconds}s` : ''}
			{:else if status === 'error'}
				{errorMessage || 'Something went wrong.'}
			{/if}
		</p>
	</section>
</main>

<style>
	.shell {
		display: grid;
		place-items: center;
		min-height: 100dvh;
		padding: 2rem 1rem;
	}

	.card {
		text-align: left;
	}

	/* Same hand as the rest of the app: 24-unit box, hairline stroke. */
	.ico {
		width: 0.95rem;
		height: 0.95rem;
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		margin-bottom: 0.6rem;
		color: var(--text-muted);
		text-decoration: none;
		font-weight: 700;
		font-size: 0.88rem;
	}

	.back:hover {
		color: var(--text);
	}

	h1 {
		margin: 0;
		font-size: 1.35rem;
	}

	h1 + .stitch {
		margin: 0.8rem 0 1.25rem;
	}

	textarea.input {
		resize: vertical;
		min-height: 5rem;
	}

	/* Native select, our marker — two gradient halves, so the caret follows the
	   ink colour in either theme. */
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

	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.6rem;
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

	.actions-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-top: 1.25rem;
	}

	/* The read-out, ruled off like a meter reading at the foot of the sheet. */
	.status-line {
		margin: 1rem 0 0;
		padding-top: 0.8rem;
		border-top: 1px solid var(--border);
		font-size: 0.9rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
</style>
