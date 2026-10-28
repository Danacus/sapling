<!--
  One searchable combobox for every language choice: names, endonyms and flags
  come from the runtime's CLDR (`$lib/text`'s `languageOptions`), and what it
  binds is the canonical BCP-47 tag.
-->
<script lang="ts">
	import { languageOption, searchLanguages, type LanguageOption } from '$lib/text';
	import Combobox from './Combobox.svelte';

	let {
		value = $bindable(),
		label,
		placeholder = 'Search languages',
		disabled = false,
		onchange
	}: {
		/** The chosen tag; `undefined` until one is picked. */
		value?: string;
		label: string;
		placeholder?: string;
		disabled?: boolean;
		onchange?: (option: LanguageOption) => void;
	} = $props();

	const selected = $derived(languageOption(value));
</script>

{#snippet flag()}
	<span class="flag" aria-hidden="true">{selected?.flag}</span>
{/snippet}

{#snippet tag()}
	<code class="tag" aria-hidden="true">{selected?.tag}</code>
{/snippet}

{#snippet row(option: LanguageOption)}
	<span class="row" class:chosen={option.tag === selected?.tag}>
		<span class="flag" aria-hidden="true">{option.flag ?? ''}</span>
		<span class="names">
			<span class="name">{option.name}</span>
			{#if option.endonym}
				<span class="endonym" lang={option.tag}>{option.endonym}</span>
			{/if}
		</span>
		<code class="tag">{option.tag}</code>
	</span>
{/snippet}

<Combobox
	{label}
	{disabled}
	search={searchLanguages}
	key={(option) => option.tag}
	selectedKey={selected?.tag}
	display={selected?.name ?? ''}
	{placeholder}
	openPlaceholder={selected?.name ?? placeholder}
	empty={(query) => `No language matches “${query}”`}
	leading={selected?.flag ? flag : undefined}
	trailing={selected ? tag : undefined}
	option={row}
	onchoose={(option) => {
		value = option.tag;
		onchange?.(option);
	}}
/>

<style>
	.row {
		display: grid;
		grid-template-columns: 1.6rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
	}

	.row.chosen .name {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.names {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0 0.5rem;
		min-width: 0;
	}

	.endonym {
		color: var(--text-muted);
		font-size: 0.9rem;
	}

	.flag {
		font-size: 1.15rem;
		line-height: 1;
	}

	.tag {
		color: var(--text-muted);
		font-size: 0.78rem;
	}
</style>
