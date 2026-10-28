<!--
  The Text tab: a paste or a .txt file, stored as it is. Free and local — the
  core's `importSource` cuts it and `addText` keeps it, no model and no task.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';

	import { addText, importSource } from '$lib/db';
	import { newUuid } from '$lib/device';
	import type { ImportedSource, ReadingText } from '$lib/types';

	import { baseName, extent, firstLine } from './compose';
	import FileSlot from './FileSlot.svelte';

	interface Props {
		/** A written text is on its way; its arrival opens it, so an import waits. */
		busy: boolean;
	}

	let { busy }: Props = $props();

	let pasted = $state('');
	let title = $state('');
	/** An uploaded file's name, the default title over the text's first line. */
	let fileName = $state('');
	let adding = $state(false);
	let error = $state('');

	let left = false;
	onDestroy(() => {
		left = true;
	});

	// One answer over one source; an answer for a source since edited is dropped.
	let imported = $state<{ source: string; result: ImportedSource }>({
		source: '',
		result: { cues: 0, durationMs: 0, segments: [] }
	});

	$effect(() => {
		const source = pasted;
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

	const segments = $derived(imported.result.segments);
	const defaultTitle = $derived(fileName || firstLine(segments));

	async function upload(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared at once, so choosing the same file twice still fires.
		input.value = '';
		if (!file) return;
		error = '';
		try {
			pasted = await file.text();
			fileName = baseName(file.name);
		} catch {
			error = 'Could not read that file.';
		}
	}

	async function add() {
		if (adding || busy) return;
		// The effect's answer can trail a keystroke; never import a stale cut.
		const cut = imported.source === pasted ? imported.result : await importSource(pasted);
		if (cut.segments.length === 0) {
			error = 'There is nothing to read in that yet.';
			return;
		}

		error = '';
		const text: ReadingText = {
			id: newUuid(),
			title: title.trim() || fileName || firstLine(cut.segments) || 'Untitled',
			source: 'imported',
			segments: cut.segments,
			createdAt: Date.now()
		};

		adding = true;
		try {
			await addText(text);
			if (!left) await goto(`/read/${text.id}`);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not import that text.';
		} finally {
			adding = false;
		}
	}
</script>

<label class="field tight">
	<span class="label">The text</span>
	<textarea
		class="input paste-input"
		rows="8"
		placeholder="Paste an article, a song, a story…"
		disabled={adding}
		bind:value={pasted}></textarea>
</label>

<div class="upload">
	<FileSlot
		label="Upload a .txt file"
		accept=".txt,text/plain"
		icon="upload"
		disabled={adding}
		onchange={(event) => void upload(event)}
	/>
</div>

{#if segments.length > 0}
	<p class="count">{extent(segments)}</p>
{/if}

<label class="field title-field">
	<span class="label">Title <span class="note">optional</span></span>
	<input
		class="input"
		type="text"
		placeholder={defaultTitle || 'Named after its first line'}
		disabled={adding}
		bind:value={title}
	/>
</label>

<button
	type="button"
	class="btn btn-primary btn-block go"
	disabled={adding || busy || segments.length === 0}
	onclick={() => void add()}
>
	{adding ? 'Importing…' : error ? 'Try again' : 'Import'}
</button>

{#if error}
	<p class="error" role="alert">{error}</p>
{/if}

<style>
	.field.tight {
		margin-bottom: 0.75rem;
	}

	.paste-input {
		min-height: 9rem;
		line-height: 1.5;
		resize: vertical;
	}

	.upload {
		margin-bottom: 0.9rem;
	}

	.count {
		margin: 0 0 0.9rem;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
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
</style>
