<!--
  A textbook's contents: its chapters in order, each with its pages and what it
  holds, each opening its own page. The book is read a chapter at a time, as
  it is printed — not a stream of pages to mark as read.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { deleteTextbook, getTextbook } from '$lib/db';
	import { chapterName, chapterSummary, pagesOf, type Textbook } from '$lib/textbook';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const id = $derived(page.params.id ?? '');

	let loading = $state(true);
	let loadError = $state('');
	let book = $state<Textbook | undefined>(undefined);
	let confirming = $state(false);
	let deleting = $state(false);

	$effect(() => {
		const bookId = id;
		let cancelled = false;
		loading = true;
		getTextbook(bookId)
			.then((loaded) => {
				if (cancelled) return;
				book = loaded;
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open that book.';
				loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	async function remove() {
		if (!book || deleting) return;
		deleting = true;
		try {
			await deleteTextbook(book.id);
			await goto('/read');
		} catch (cause) {
			loadError = cause instanceof Error ? cause.message : 'Could not delete that book.';
			deleting = false;
		}
	}
</script>

<main class="shell shell-wide">
	<header class="topbar ll-rise">
		<BackLink href="/read" label="Back to your media" />
		<div class="identity">
			<p class="eyebrow">Textbook</p>
			<h1>{book?.title ?? 'Textbook'}</h1>
		</div>
		{#if book}
			<button
				type="button"
				class="btn btn-ghost tool"
				class:is-active={confirming}
				onclick={() => (confirming = !confirming)}
			>
				Delete
			</button>
		{/if}
	</header>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if loading}
		<div class="loading"><Spinner /></div>
	{:else if !book}
		<p class="empty">That book is not in your library.</p>
	{:else}
		{#if confirming}
			<div class="card confirm" role="alertdialog" aria-labelledby="confirm-title">
				<p id="confirm-title" class="confirm-title">Delete this book?</p>
				<p class="confirm-body">
					Its {book.chapters.length} chapters go from every device you sync. Words you added from it stay
					in your garden.
				</p>
				<div class="confirm-actions">
					<button
						type="button"
						class="btn btn-ghost danger"
						disabled={deleting}
						onclick={() => void remove()}
					>
						{deleting ? 'Deleting…' : 'Delete'}
					</button>
					<button type="button" class="btn btn-ghost" onclick={() => (confirming = false)}
						>Keep it</button
					>
				</div>
			</div>
		{/if}

		{#if book.fileName}<p class="file">From {book.fileName}</p>{/if}

		<ol class="chapters">
			{#each book.chapters as chapter, i (i)}
				<li>
					<a class="chapter" href={`/read/book/${book.id}/${i + 1}`}>
						<span class="chapter-name">{chapterName(chapter)}</span>
						<span class="chapter-meta"
							>{[pagesOf(chapter), chapterSummary(chapter)].filter(Boolean).join(' · ')}</span
						>
					</a>
				</li>
			{/each}
		</ol>
	{/if}
</main>

<style>
	.shell {
		padding-block: var(--gutter) 5rem;
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.identity {
		min-width: 0;
		flex: 1;
	}

	.eyebrow {
		margin: 0;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
		font-size: 0.72rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.55rem;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}

	.tool {
		padding: 0.4rem 0.85rem;
		border-color: var(--border);
		font-size: 0.82rem;
	}

	.tool.is-active {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.btn.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
		color: var(--danger);
	}

	.btn.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 40dvh;
	}

	.empty,
	.file {
		color: var(--text-muted);
	}

	.file {
		margin: 0 0 1rem;
		font-size: 0.85rem;
	}

	.error {
		padding: 0.6rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-weight: 700;
	}

	.confirm {
		margin-bottom: 1rem;
	}

	.confirm-title {
		margin: 0 0 0.35rem;
		font-weight: 700;
	}

	.confirm-body {
		margin: 0 0 0.9rem;
		color: var(--text-muted);
		font-size: 0.9rem;
	}

	.confirm-actions {
		display: flex;
		gap: 0.6rem;
	}

	.chapters {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.5rem;
	}

	.chapter {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-height: 3.25rem;
		padding: 0.75rem 0.95rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		text-decoration: none;
	}

	.chapter:hover {
		border-color: var(--text-muted);
	}

	.chapter-name {
		font-weight: 700;
		font-size: 1.05rem;
	}

	.chapter-meta {
		font-size: 0.82rem;
		color: var(--text-muted);
	}
</style>
