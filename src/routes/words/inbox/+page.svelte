<!--
  The words the learner collected on web pages with the companion extension.
  The inbox lives in the extension, never in the database: this page pulls it
  over the bridge (`$lib/extension/bridge`), groups it by page, and files words
  through the same tick / Find meanings / Add list a text's Words page uses;
  what is added or dismissed is dropped from the extension's inbox.
-->
<script lang="ts">
	import { getAllItems, getProfile } from '$lib/db';
	import { getExtensionInbox, removeFromExtensionInbox } from '$lib/extension/bridge';
	import { groupInbox, type InboxEntry } from '$lib/extension/protocol';
	import { primarySubtag, targetTagOf, termKey } from '$lib/text';
	import type { KnowledgeItem, Profile } from '$lib/types';
	import BackLink from '$lib/ui/BackLink.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';
	import WordHarvest, { type HarvestGroup } from '$lib/ui/WordHarvest.svelte';

	let loading = $state(true);
	let loadError = $state('');
	let error = $state('');
	let outcome = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	/** `undefined` while no extension has answered. */
	let inbox = $state<InboxEntry[] | undefined>(undefined);

	async function load() {
		const [loadedProfile, loadedItems, entries] = await Promise.all([
			getProfile(),
			getAllItems(),
			getExtensionInbox()
		]);
		profile = loadedProfile;
		items = loadedItems;
		inbox = entries;
	}

	$effect(() => {
		load()
			.catch((cause) => {
				loadError = cause instanceof Error ? cause.message : 'Could not open the inbox.';
			})
			.finally(() => {
				loading = false;
			});
	});

	const language = $derived(primarySubtag(profile && targetTagOf(profile)));
	const current = $derived(
		(inbox ?? []).filter((entry) => primarySubtag(entry.language) === language)
	);
	const elsewhere = $derived((inbox?.length ?? 0) - current.length);
	const held = $derived(new Set(items.map((item) => termKey(item.term))));

	const groups = $derived<HarvestGroup[]>(
		groupInbox(current).map((page) => ({
			key: page.url,
			title: page.title,
			href: page.url,
			words: page.entries.map((entry) => ({
				id: entry.id,
				term: entry.term,
				reading: entry.reading ?? null,
				sentence: entry.sentence,
				tags: held.has(termKey(entry.term)) ? ['in your garden'] : []
			}))
		}))
	);

	async function drop(ids: string[]) {
		error = '';
		try {
			await removeFromExtensionInbox(ids);
			await load();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not update the inbox.';
		}
	}

	async function added(ids: string[], summary: string) {
		outcome = summary;
		await drop(ids);
	}
</script>

<svelte:head>
	<title>Inbox</title>
</svelte:head>

<main class="shell shell-wide">
	<header class="topbar ll-rise">
		<BackLink href="/words" label="Back to the garden" />
		<div class="identity">
			<p class="eyebrow">Garden</p>
			<h1>Inbox</h1>
		</div>
	</header>

	{#if loadError}
		<p class="error" role="alert">{loadError}</p>
	{:else if loading}
		<div class="loading"><Spinner /></div>
	{:else if inbox === undefined}
		<section class="card explain">
			<p>
				The inbox holds words you collect while browsing, with the Sapling browser extension. It
				underlines the words you already have on any page, and a click on any other word collects it
				here with its sentence.
			</p>
			<p class="muted">
				The extension isn't answering in this tab. Install it, or reload this page if you just did.
			</p>
		</section>
	{:else if current.length === 0}
		{#if outcome}<p class="outcome" aria-live="polite">{outcome}</p>{/if}
		<p class="empty">
			Nothing collected yet. Click a word on any web page with the Sapling extension on, and it
			lands here.
		</p>
	{:else if profile}
		<WordHarvest
			{profile}
			{groups}
			summary={`${current.length} collected word${current.length === 1 ? '' : 's'}`}
			onadded={added}
			ondismiss={(id) => void drop([id])}
		/>
	{/if}

	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if !loading && elsewhere > 0}
		<p class="empty">
			{elsewhere} more in another language, kept in the inbox.
		</p>
	{/if}
</main>

<style>
	.shell {
		padding-block: var(--gutter) 6rem;
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
		line-height: 1.1;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 40dvh;
	}

	.explain {
		max-width: var(--measure);
	}

	.explain p {
		margin: 0 0 0.6rem;
	}

	.muted,
	.empty {
		color: var(--text-muted);
	}

	.outcome {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.error {
		color: var(--danger);
		font-weight: 700;
	}
</style>
