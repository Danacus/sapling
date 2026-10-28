<!--
  One searchable combobox for every language choice: names, endonyms and flags
  come from the runtime's CLDR (`$lib/text`'s `languageOptions`), and what it
  binds is the canonical BCP-47 tag. The ARIA combobox pattern: focus stays in
  the input, the active option is `aria-activedescendant`.
-->
<script lang="ts">
	import { languageOption, searchLanguages, type LanguageOption } from '$lib/text';

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

	const id = $props.id();
	const listId = `${id}-list`;
	const optionId = (index: number) => `${id}-option-${index}`;

	let query = $state('');
	let open = $state(false);
	let active = $state(0);

	const selected = $derived(languageOption(value));
	const results = $derived(open ? searchLanguages(query) : []);

	function show() {
		if (open || disabled) return;
		query = '';
		open = true;
		active = Math.max(
			0,
			searchLanguages('').findIndex((option) => option.tag === selected?.tag)
		);
	}

	function hide() {
		open = false;
		query = '';
	}

	function choose(option: LanguageOption) {
		value = option.tag;
		hide();
		onchange?.(option);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			if (!open) return show();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			active = Math.min(Math.max(active + step, 0), Math.max(results.length - 1, 0));
		} else if (event.key === 'Enter' && open) {
			event.preventDefault();
			const option = results[active];
			if (option) choose(option);
		} else if (event.key === 'Escape' && open) {
			event.preventDefault();
			hide();
		}
	}

	$effect(() => {
		if (!open) return;
		document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
	});
</script>

<div class="field picker">
	<label class="label" for={id}>{label}</label>
	<div class="control">
		{#if !open && selected?.flag}
			<span class="flag" aria-hidden="true">{selected.flag}</span>
		{/if}
		<input
			{id}
			class="input"
			class:flagged={!open && selected?.flag}
			type="text"
			role="combobox"
			aria-expanded={open}
			aria-controls={listId}
			aria-autocomplete="list"
			aria-activedescendant={open && results[active] ? optionId(active) : undefined}
			autocomplete="off"
			spellcheck="false"
			{disabled}
			placeholder={open ? (selected?.name ?? placeholder) : placeholder}
			value={open ? query : (selected?.name ?? '')}
			onfocus={show}
			onclick={show}
			onblur={hide}
			oninput={(event) => {
				query = event.currentTarget.value;
				open = true;
				active = 0;
			}}
			{onkeydown}
		/>
		{#if !open && selected}
			<code class="tag" aria-hidden="true">{selected.tag}</code>
		{/if}
	</div>

	{#if open}
		<!-- mousedown keeps focus in the input, so a tap is a click and not a blur. -->
		<ul id={listId} class="list" role="listbox" aria-label={label}>
			{#each results as option, index (option.tag)}
				<li
					id={optionId(index)}
					class="option"
					class:active={index === active}
					role="option"
					aria-selected={option.tag === selected?.tag}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => choose(option)}
					{onkeydown}
					onmousemove={() => (active = index)}
				>
					<span class="flag" aria-hidden="true">{option.flag ?? ''}</span>
					<span class="names">
						<span class="name">{option.name}</span>
						{#if option.endonym}
							<span class="endonym" lang={option.tag}>{option.endonym}</span>
						{/if}
					</span>
					<code class="tag">{option.tag}</code>
				</li>
			{:else}
				<li class="empty" role="option" aria-selected="false" aria-disabled="true">
					No language matches “{query}”
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.picker {
		position: relative;
	}

	.control {
		position: relative;
		display: flex;
		align-items: center;
	}

	.control > .flag {
		position: absolute;
		left: 0.85rem;
		pointer-events: none;
	}

	.control > .tag {
		position: absolute;
		right: 0.85rem;
		pointer-events: none;
	}

	.input {
		padding-right: 4.5rem;
	}

	.input.flagged {
		padding-left: 2.6rem;
	}

	.list {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		z-index: 10;
		max-height: min(18rem, 50dvh);
		margin: 0.3rem 0 0;
		padding: 0.25rem;
		overflow-y: auto;
		overscroll-behavior: contain;
		list-style: none;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		box-shadow: var(--shadow);
	}

	.option {
		display: grid;
		grid-template-columns: 1.6rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.6rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.option.active {
		background: var(--surface-alt);
	}

	.option[aria-selected='true'] .name {
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

	.empty {
		padding: 0.55rem 0.6rem;
		color: var(--text-muted);
	}
</style>
