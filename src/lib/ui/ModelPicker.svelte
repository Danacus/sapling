<!--
  The model id, searched over what the endpoint lists. Any typed id stays
  usable — offered as itself, and kept on blur — so an endpoint without a list
  (or no network) leaves an ordinary text field.
-->
<script lang="ts">
	import { DEFAULT_MODEL } from '$lib/db/settings';
	import {
		fetchModels,
		modelDetail,
		searchModels,
		type ModelChoice,
		type ModelInfo
	} from '$lib/llm/models';
	import Combobox from './Combobox.svelte';

	let {
		value = $bindable(''),
		label = 'Model',
		baseUrl,
		apiKey
	}: {
		value?: string;
		label?: string;
		/** The endpoint whose `/models` to list; blank is OpenRouter. */
		baseUrl?: string;
		apiKey?: string;
	} = $props();

	let models = $state<ModelInfo[]>([]);

	$effect(() => {
		let current = true;
		void fetchModels(baseUrl, apiKey).then((listed) => {
			if (current) models = listed;
		});
		return () => {
			current = false;
		};
	});
</script>

{#snippet row(choice: ModelChoice)}
	<span class="row" class:chosen={choice.id === value}>
		{#if choice.model}
			<span class="name">{choice.model.name ?? choice.id}</span>
			<span class="detail">
				{#if choice.model.name}<code class="id">{choice.id}</code>{/if}
				{#if modelDetail(choice.model)}<span>{modelDetail(choice.model)}</span>{/if}
			</span>
		{:else}
			<span class="name">Use “{choice.id}”</span>
		{/if}
	</span>
{/snippet}

<Combobox
	{label}
	search={(query) => searchModels(models, query)}
	key={(choice) => choice.id}
	selectedKey={value}
	display={value}
	placeholder={DEFAULT_MODEL}
	openPlaceholder={value || DEFAULT_MODEL}
	option={row}
	onchoose={(choice) => (value = choice.id)}
	onleave={(query) => (value = query)}
/>

<style>
	.row {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.row.chosen .name {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.name {
		overflow-wrap: anywhere;
	}

	.detail {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.6rem;
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.id {
		overflow-wrap: anywhere;
	}
</style>
