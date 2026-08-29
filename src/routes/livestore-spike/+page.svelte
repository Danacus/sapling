<script lang="ts">
	/**
	 * SPIKE — proves the LiveStore web adapter boots inside *this* app: an
	 * `ssr = false` adapter-static SPA, with a service worker already installed
	 * and no cross-origin isolation (which `static/_headers` deliberately omits
	 * so the Kokoro TTS mirror fetches keep working).
	 *
	 * Delete this route once the decision is made — it is evidence, not a feature.
	 */
	import { makePersistedAdapter } from '@livestore/adapter-web';
	import LiveStoreSharedWorker from '@livestore/adapter-web/shared-worker?sharedworker';
	import { queryDb, type Store } from '@livestore/livestore';
	import { createStore } from '@livestore/svelte';
	import { onMount } from 'svelte';

	import LiveStoreWorker from '$lib/livestore/livestore.worker?worker';
	import { events, schema, tables } from '$lib/livestore/schema';

	let store = $state<Store<typeof schema> | undefined>();
	let failure = $state<string | undefined>();
	let isolated = $state<boolean | undefined>();

	const items$ = queryDb(tables.items, { label: 'spike-items' });
	const reviews$ = queryDb(tables.reviews, { label: 'spike-reviews' });

	onMount(async () => {
		// The headline question: OPFS + workers + WASM, with COOP/COEP absent.
		isolated = globalThis.crossOriginIsolated;
		try {
			store = await createStore<typeof schema>({
				adapter: makePersistedAdapter({
					worker: LiveStoreWorker,
					sharedWorker: LiveStoreSharedWorker,
					storage: { type: 'opfs' }
				}),
				schema,
				storeId: 'spike'
			});
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
	});

	const items = $derived(store ? store.query(items$) : []);
	const reviews = $derived(store ? store.query(reviews$) : []);

	const addItem = () => {
		const id = crypto.randomUUID();
		store?.commit(
			events.itemAdded({
				id,
				kind: 'vocab',
				term: '书',
				meaning: 'book',
				romanization: 'shū',
				introducedAt: Date.now()
			})
		);
	};

	const review = (itemId: string) =>
		store?.commit(
			events.itemReviewed({
				eventId: crypto.randomUUID(),
				device: 'spike-device',
				itemId,
				at: Date.now(),
				grade: 3
			})
		);
</script>

<svelte:head><title>LiveStore spike</title></svelte:head>

<main>
	<h1>LiveStore spike</h1>

	<p class="status">
		{#if failure}
			<strong>Adapter failed:</strong>
			{failure}
		{:else if store}
			Store booted from OPFS. crossOriginIsolated = <code>{String(isolated)}</code>.
		{:else}
			Booting…
		{/if}
	</p>

	<p>Reload the page — rows persist because they are replayed from the eventlog.</p>

	<button onclick={addItem} disabled={!store}>Add an item</button>

	<ul>
		{#each items as item (item.id)}
			<li>
				<span>{item.term} — {item.meaning}</span>
				<button onclick={() => review(item.id)}>Review</button>
				<span class="count">
					{reviews.filter((r) => r.itemId === item.id).length} reviews
				</span>
			</li>
		{/each}
	</ul>
</main>

<style>
	main {
		padding: 1rem;
		max-width: 34rem;
	}

	.status {
		font-size: 0.875rem;
	}

	ul {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}

	li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.count {
		font-size: 0.875rem;
		opacity: 0.7;
	}
</style>
