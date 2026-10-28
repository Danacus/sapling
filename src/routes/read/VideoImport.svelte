<!--
  The Video tab: the recording first, its text following from it. A YouTube
  link lists its caption tracks by itself and a picked track becomes the
  subtitles; your own files — a recording and its subtitle file — are the
  quieter second way. Stored as a reference only: a video id, or a file's name.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, untrack } from 'svelte';

	import { addText, importSource } from '$lib/db';
	import { newUuid } from '$lib/device';
	import { listCaptions, rememberFile, videoIdFrom } from '$lib/media';
	import type { CaptionsListing, CaptionTrack } from '$lib/media';
	import { SETTLED, rootOf, startTask, taskOutcome } from '$lib/tasks';
	import { taskStore } from '$lib/tasks/store.svelte';
	import type { ImportedSource, ReadingMedia, ReadingText } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	import { FORMAT_NAMES, baseName, clock, firstLine, isTimed } from './compose';
	import FileSlot from './FileSlot.svelte';

	interface Props {
		/** A written text is on its way; its arrival opens it, so an import waits. */
		busy: boolean;
	}

	let { busy }: Props = $props();

	let link = $state('');
	const linkId = $derived(videoIdFrom(link));
	let mediaFile = $state<File | undefined>(undefined);
	let mediaInput = $state<HTMLInputElement | null>(null);
	/** The timed text: a fetched track (with the video it is for) or an uploaded file. */
	let subtitles = $state<{ name: string; text: string; videoId?: string } | undefined>(undefined);
	let title = $state('');
	let adding = $state(false);
	let error = $state('');

	let listing = $state<CaptionsListing | undefined>(undefined);
	/** The video last asked about, so the same id is never listed twice. */
	let askedFor = $state<string | undefined>(undefined);
	let looking = $state(false);
	let captionsError = $state('');
	const fetching = $derived(taskStore.running.some((task) => task.kind === 'captions'));

	let left = false;
	onDestroy(() => {
		left = true;
	});

	// One answer over one source; an answer for a source since replaced is dropped.
	let imported = $state<{ source: string; result: ImportedSource }>({
		source: '',
		result: { cues: 0, durationMs: 0, segments: [] }
	});

	$effect(() => {
		const source = subtitles?.text ?? '';
		let stale = false;
		importSource(source).then(
			(result) => {
				if (!stale) imported = { source, result };
			},
			() => {}
		);
		return () => {
			stale = true;
		};
	});

	const plan = $derived(imported.result);
	const timed = $derived(isTimed(plan.segments));
	const recording = $derived<ReadingMedia | undefined>(
		linkId
			? { kind: 'youtube', videoId: linkId }
			: mediaFile
				? {
						kind: 'file',
						name: mediaFile.name,
						...(mediaFile.type ? { type: mediaFile.type } : {})
					}
				: undefined
	);
	const tracks = $derived(linkId && listing?.id === linkId ? listing.tracks : []);
	const defaultTitle = $derived(
		(linkId && listing?.id === linkId ? listing.title : '') ||
			(subtitles && !subtitles.videoId ? baseName(subtitles.name) : '') ||
			(mediaFile ? baseName(mediaFile.name) : '') ||
			firstLine(plan.segments)
	);
	/** What the dead Import button cannot say for itself. */
	const missing = $derived(
		subtitles && !recording
			? 'Add the video it belongs to: a YouTube link or a file.'
			: mediaFile && !subtitles
				? 'A recording needs its subtitles: upload a subtitle file.'
				: ''
	);

	// A link that names a new video lists its tracks; no button to press.
	$effect(() => {
		const id = linkId;
		if (id && id !== untrack(() => askedFor)) void listTracks(id);
	});

	async function listTracks(id: string) {
		askedFor = id;
		captionsError = '';
		looking = true;
		try {
			const answer = await listCaptions(id);
			if (askedFor !== id) return;
			listing = answer;
			if (answer.tracks.length === 0) captionsError = 'That video has no captions.';
		} catch (cause) {
			if (askedFor !== id) return;
			captionsError =
				cause instanceof Error ? cause.message : 'Could not ask YouTube about that video.';
		} finally {
			if (askedFor === id) looking = false;
		}
	}

	function enterLink(event: Event) {
		link = (event.currentTarget as HTMLInputElement).value;
		const id = videoIdFrom(link);
		// Fetched captions belong to their video, not to whatever is linked next.
		if (id && subtitles?.videoId && subtitles.videoId !== id) subtitles = undefined;
		if (link.trim() === '') return;
		// One recording: a link replaces the file (whose value only the element can clear).
		mediaFile = undefined;
		if (mediaInput) mediaInput.value = '';
	}

	function chooseRecording(event: Event) {
		mediaFile = (event.currentTarget as HTMLInputElement).files?.[0];
		if (mediaFile) link = '';
	}

	async function uploadSubtitles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		error = '';
		try {
			const text = await file.text();
			if ((await importSource(text)).format) subtitles = { name: file.name, text };
			else error = 'That file has no timings. Plain text goes in the Text tab.';
		} catch {
			error = 'Could not read that file.';
		}
	}

	// Caption fetches this form started, task id → video id. Records, not
	// promises: a Retry in the tray is a new record descending from ours.
	const mine = new Map<string, string>();
	const handled = new Set<string>();

	$effect(() => {
		const tasks = taskStore.tasks;
		for (const task of tasks) {
			if (handled.has(task.id)) continue;
			const videoId = mine.get(rootOf(tasks, task.id));
			if (videoId === undefined) continue;
			mine.set(task.id, videoId);
			if (!SETTLED.has(task.status)) continue;
			handled.add(task.id);
			void landed(task.id, videoId);
		}
	});

	async function landed(id: string, videoId: string) {
		const outcome = await taskOutcome('captions', id);
		if (!outcome || left) return;
		if (outcome.status === 'done') {
			error = '';
			subtitles = { name: outcome.result.name, text: outcome.result.text, videoId };
		} else if (outcome.status === 'failed') captionsError = outcome.error;
	}

	function pickTrack(track: CaptionTrack) {
		if (!linkId || fetching) return;
		captionsError = '';
		const { id } = startTask('captions', { videoId: linkId, ...track });
		mine.set(id, linkId);
	}

	async function add() {
		if (adding || busy || !recording) return;
		const source = subtitles?.text ?? '';
		// The effect's answer can trail a change; never import a stale cut.
		const { segments } = imported.source === source ? imported.result : await importSource(source);
		if (!isTimed(segments)) {
			error = 'Those subtitles have no timings to follow.';
			return;
		}

		error = '';
		const media = recording;
		const text: ReadingText = {
			id: newUuid(),
			title: title.trim() || defaultTitle || 'Untitled',
			source: 'imported',
			segments,
			media,
			createdAt: Date.now()
		};

		adding = true;
		try {
			await addText(text);
			if (media.kind === 'file' && mediaFile) rememberFile(text.id, mediaFile);
			if (!left) await goto(`/read/${text.id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not import that video.';
		} finally {
			adding = false;
		}
	}
</script>

<label class="field tight">
	<span class="label">YouTube link</span>
	<input
		class="input"
		type="url"
		inputmode="url"
		placeholder="https://www.youtube.com/watch?v=…"
		disabled={adding}
		value={link}
		oninput={enterLink}
	/>
</label>
{#if link.trim() && !linkId}
	<p class="hint line">That is not a YouTube link.</p>
{/if}

{#if subtitles}
	<div class="source-card ll-rise">
		<svg class="ico source-mark" viewBox="0 0 24 24" aria-hidden="true">
			<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.2" />
			<path d="M7 12.4h4.2M13.4 12.4H17M7 15.4h7M16.2 15.4H17" />
		</svg>
		<div class="source-id">
			<p class="source-kind">{plan.format ? FORMAT_NAMES[plan.format] : 'Subtitles'}</p>
			<p class="source-name">{subtitles.name}</p>
			<p class="source-facts" class:trouble={imported.source === subtitles.text && !timed}>
				{#if imported.source === subtitles.text && !timed}
					Nothing to follow in that file
				{:else}
					{plan.cues} line{plan.cues === 1 ? '' : 's'}{plan.durationMs > 0
						? ` · ${clock(plan.durationMs)}`
						: ''}
				{/if}
			</p>
		</div>
		<button
			type="button"
			class="source-drop"
			aria-label="Remove {subtitles.name}"
			disabled={adding}
			onclick={() => (subtitles = undefined)}
		>
			<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
				<path d="m7 7 10 10M17 7 7 17" />
			</svg>
		</button>
	</div>
{:else if fetching}
	<p class="status"><Spinner /> Fetching captions…</p>
{:else if linkId && looking}
	<p class="status"><Spinner /> Looking for captions…</p>
{:else if tracks.length > 0}
	<p class="tracks-head">Pick the captions</p>
	<ul class="tracks">
		{#each tracks as track (`${track.auto}:${track.lang}:${track.name}`)}
			<li>
				<button type="button" class="track" disabled={adding} onclick={() => pickTrack(track)}>
					<span class="track-name">{track.name}</span>
					<span class="track-lang">{track.lang}</span>
					{#if track.auto}<span class="track-auto">auto</span>{/if}
				</button>
			</li>
		{/each}
	</ul>
{/if}

{#if captionsError && linkId}
	<p class="error captions-error" role="alert">
		{captionsError}
		{#if !looking && listing?.id !== linkId}
			<button type="button" class="retry" onclick={() => linkId && void listTracks(linkId)}>
				Try again
			</button>
		{/if}
	</p>
{/if}

<div class="own">
	<p class="own-head">Or use your own files</p>
	<div class="own-row">
		<FileSlot
			label={mediaFile ? mediaFile.name : 'Video or audio file'}
			accept="video/*,audio/*"
			icon="video"
			disabled={adding}
			bind:input={mediaInput}
			onchange={chooseRecording}
		/>
		<FileSlot
			label="Subtitle file"
			accept=".srt,.vtt,.json3,.json,.txt"
			icon="subtitles"
			disabled={adding}
			onchange={(event) => void uploadSubtitles(event)}
		/>
	</div>
	{#if mediaFile}
		<p class="hint line">
			Only its name is kept, so you'll pick the file again when you open this.
		</p>
	{/if}
</div>

<label class="field title-field">
	<span class="label">Title <span class="note">optional</span></span>
	<input
		class="input"
		type="text"
		placeholder={defaultTitle || 'Named after the video'}
		disabled={adding}
		bind:value={title}
	/>
</label>

<button
	type="button"
	class="btn btn-primary btn-block go"
	disabled={adding || busy || fetching || !recording || !timed}
	onclick={() => void add()}
>
	{adding ? 'Importing…' : error ? 'Try again' : 'Import'}
</button>

{#if missing}
	<p class="hint line">{missing}</p>
{/if}
{#if error}
	<p class="error" role="alert">{error}</p>
{/if}

<style>
	.field.tight {
		margin-bottom: 0.75rem;
	}

	.line {
		margin: 0 0 0.75rem;
		font-size: 0.8rem;
		overflow-wrap: anywhere;
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

	/* What a waiting step is doing, with the spinner shrunk to sit in the line. */
	.status {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0 0 0.9rem;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.status :global(.spinner) {
		width: 1.1rem;
		height: 1.1rem;
		margin: 0;
	}

	.status :global(.spinner)::after {
		display: none;
	}

	/* The subtitles, as an object --------------------------------------- */

	/* Dressed like a shelf row: it is one, a few seconds early. */
	.source-card {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		margin-bottom: 0.9rem;
		padding: 0.85rem 0.9rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.source-mark {
		margin-top: 0.15rem;
		color: color-mix(in srgb, var(--primary) 70%, var(--text-muted));
	}

	.source-id {
		flex: 1 1 auto;
		min-width: 0;
	}

	.source-kind {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.source-name {
		margin: 0.1rem 0 0;
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	.source-facts {
		margin: 0.3rem 0 0;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.source-facts.trouble {
		color: var(--danger);
		font-weight: 700;
	}

	.source-drop {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.source-drop:hover:not(:disabled) {
		border-color: var(--border-strong);
		background: var(--surface);
		color: var(--text);
	}

	.source-drop:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.source-drop:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* The track chips ----------------------------------------------------- */

	.tracks-head {
		margin: 0 0 0.45rem;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--text-muted);
	}

	/* Machine translations are filtered out a layer down, so this is a handful;
	   the cap is for the video that has twenty anyway. */
	.tracks {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		max-height: 11rem;
		margin: 0 0 0.9rem;
		padding: 0;
		overflow-y: auto;
	}

	.track {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.4rem 0.8rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.track:hover:not(:disabled) {
		border-color: var(--text-muted);
		background: var(--surface-alt);
	}

	.track:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.track-name {
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.track-lang {
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	/* Machine-written, and the quality difference is large enough to mark. */
	.track-auto {
		padding: 0.05rem 0.4rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.retry {
		margin-left: 0.4rem;
		padding: 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}

	/* Your own files: the second way, set apart and quieter ---------------- */

	.own {
		margin: 0.4rem 0 1.1rem;
		padding-top: 0.9rem;
		border-top: 1px dashed var(--border);
	}

	.own-head {
		margin: 0 0 0.55rem;
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.own-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-bottom: 0.6rem;
	}

	.own-row > :global(*) {
		flex: 1 1 11rem;
		min-width: 0;
	}

	.own .line {
		margin-bottom: 0;
	}

	.title-field {
		margin-bottom: 1rem;
	}

	.note {
		margin-left: 0.35rem;
		font-weight: 400;
		letter-spacing: 0.04em;
		text-transform: none;
		opacity: 0.8;
	}

	.go {
		padding: 0.85rem 1.4rem;
	}

	.go + .line {
		margin: 0.6rem 0 0;
	}

	.error {
		margin: 0.9rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.captions-error {
		margin: 0 0 0.9rem;
		font-size: 0.82rem;
	}
</style>
