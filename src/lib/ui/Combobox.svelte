<!--
  The searchable list behind every picker: the caller supplies the search and
  how an option looks; this owns the ARIA combobox pattern — focus stays in the
  input, the active option is `aria-activedescendant` — and the keyboard.
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';

	let {
		label,
		search,
		key,
		selectedKey,
		display,
		placeholder = '',
		openPlaceholder = placeholder,
		disabled = false,
		empty,
		leading,
		trailing,
		option: optionSnippet,
		onchoose,
		onleave
	}: {
		label: string;
		/** The options for a query, best first; a blank query is the whole list. */
		search: (query: string) => T[];
		key: (option: T) => string;
		/** The chosen option's key, for `aria-selected` and where the list opens. */
		selectedKey?: string;
		/** What the closed input shows. */
		display: string;
		placeholder?: string;
		openPlaceholder?: string;
		disabled?: boolean;
		/** The line shown when a query matches nothing. */
		empty?: (query: string) => string;
		/** Drawn inside the closed input, before and after its text. */
		leading?: Snippet;
		trailing?: Snippet;
		option: Snippet<[T]>;
		onchoose: (option: T) => void;
		/** A blur with a typed query and no choice; Escape discards instead. */
		onleave?: (query: string) => void;
	} = $props();

	const id = $props.id();
	const listId = `${id}-list`;
	const optionId = (index: number) => `${id}-option-${index}`;

	let query = $state('');
	let open = $state(false);
	let active = $state(0);

	const results = $derived(open ? search(query) : []);

	function show() {
		if (open || disabled) return;
		query = '';
		open = true;
		active = Math.max(
			0,
			search('').findIndex((option) => key(option) === selectedKey)
		);
	}

	function hide() {
		open = false;
		query = '';
	}

	function choose(option: T) {
		hide();
		onchoose(option);
	}

	function onblur() {
		const typed = query.trim();
		hide();
		if (typed) onleave?.(typed);
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
			if (option !== undefined) choose(option);
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
		{#if !open && leading}
			<span class="leading">{@render leading()}</span>
		{/if}
		<input
			{id}
			class="input"
			class:has-leading={!open && leading}
			class:has-trailing={trailing}
			type="text"
			role="combobox"
			aria-expanded={open}
			aria-controls={listId}
			aria-autocomplete="list"
			aria-activedescendant={open && results[active] !== undefined ? optionId(active) : undefined}
			autocomplete="off"
			spellcheck="false"
			{disabled}
			placeholder={open ? openPlaceholder : placeholder}
			value={open ? query : display}
			onfocus={show}
			onclick={show}
			{onblur}
			oninput={(event) => {
				query = event.currentTarget.value;
				open = true;
				active = 0;
			}}
			{onkeydown}
		/>
		{#if !open && trailing}
			<span class="trailing">{@render trailing()}</span>
		{/if}
	</div>

	{#if open && (results.length > 0 || empty)}
		<!-- mousedown keeps focus in the input, so a tap is a click and not a blur. -->
		<ul id={listId} class="list" role="listbox" aria-label={label}>
			{#each results as option, index (key(option))}
				<li
					id={optionId(index)}
					class="option"
					class:active={index === active}
					role="option"
					aria-selected={key(option) === selectedKey}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => choose(option)}
					{onkeydown}
					onmousemove={() => (active = index)}
				>
					{@render optionSnippet(option)}
				</li>
			{:else}
				<li class="empty" role="option" aria-selected="false" aria-disabled="true">
					{empty?.(query)}
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

	.leading {
		position: absolute;
		left: 0.85rem;
		pointer-events: none;
	}

	.trailing {
		position: absolute;
		right: 0.85rem;
		pointer-events: none;
	}

	.input.has-leading {
		padding-left: 2.6rem;
	}

	.input.has-trailing {
		padding-right: 4.5rem;
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
		padding: 0.55rem 0.6rem;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.option.active {
		background: var(--surface-alt);
	}

	.empty {
		padding: 0.55rem 0.6rem;
		color: var(--text-muted);
	}
</style>
