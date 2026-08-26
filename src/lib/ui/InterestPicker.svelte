<!--
  The interest tag input: chosen topics as removable chips, a free-text field,
  and the suggestions not yet taken.

  Onboarding and the profile screen both ask for these, and both carried their
  own copy of the list, the add/remove/keydown trio and the chip styling. The
  copies had already drifted — one filtered the suggestions case-sensitively,
  so the same chip behaved differently depending on which screen you were on.

  `commitDraft` exists for a caller that saves without the field being blurred
  first: a tag still sitting in the input is one the learner clearly meant to
  add, and making them press Enter would just lose it silently.
-->
<script lang="ts">
	let {
		interests = $bindable(),
		label = ''
	}: {
		interests: string[];
		/** Accessible name for the text field, where the surrounding form lacks one. */
		label?: string;
	} = $props();

	const SUGGESTIONS = [
		'travel',
		'cooking',
		'music',
		'films & TV',
		'football',
		'work & business',
		'video games',
		'books'
	];

	let draft = $state('');

	const has = (value: string) =>
		interests.some((interest) => interest.toLowerCase() === value.toLowerCase());

	const remaining = $derived(SUGGESTIONS.filter((suggestion) => !has(suggestion)));

	function add(raw: string) {
		const value = raw.trim().replace(/,+$/, '').trim();
		if (!value) return;
		if (!has(value)) interests = [...interests, value];
		draft = '';
	}

	function remove(value: string) {
		interests = interests.filter((interest) => interest !== value);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			add(draft);
		} else if (event.key === 'Backspace' && draft === '' && interests.length > 0) {
			interests = interests.slice(0, -1);
		}
	}

	/** Adds whatever is still typed but unsubmitted. Called via `bind:this`. */
	export function commitDraft() {
		add(draft);
	}
</script>

{#if interests.length > 0}
	<div class="chips">
		{#each interests as interest (interest)}
			<button
				type="button"
				class="chip selected"
				onclick={() => remove(interest)}
				aria-label={`Remove ${interest}`}
			>
				{interest}<svg class="x" viewBox="0 0 24 24" aria-hidden="true">
					<path d="m7 7 10 10M17 7 7 17" />
				</svg>
			</button>
		{/each}
	</div>
{/if}
<input
	class="input"
	bind:value={draft}
	onkeydown={onKeydown}
	onblur={() => add(draft)}
	placeholder="Type a topic and press Enter"
	autocomplete="off"
	aria-label={label || undefined}
/>
{#if remaining.length > 0}
	<div class="chips suggestions">
		{#each remaining as suggestion (suggestion)}
			<button type="button" class="chip" onclick={() => add(suggestion)}>
				+ {suggestion}
			</button>
		{/each}
	</div>
{/if}

<style>
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 0.6rem;
	}

	.suggestions {
		margin: 0.6rem 0 0;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.7rem;
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

	.chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.chip.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--text);
		font-weight: 700;
	}

	/* The pages that used to own this markup styled the glyph through their own
	   scoped `.ico`, which cannot reach in here — so the stroke settings travel
	   with the component rather than being inherited by luck. */
	.chip .x {
		width: 0.8rem;
		height: 0.8rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0.55;
	}

	.chip:hover .x {
		opacity: 1;
	}
</style>
