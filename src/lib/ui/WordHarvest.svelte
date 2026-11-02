<!--
  A list of words the learner might add, shared by a text's Words page and the
  extension inbox: tick, Find meanings (one `glossWords` call, each word with
  its sentence) into editable fields, then Add through `addWords`, the one route
  by which vocabulary enters the collection. Nothing is ticked for the learner;
  the page decides what a filed word means for its own list (`onadded`).
-->
<script lang="ts" module>
	export interface HarvestWord {
		id: string;
		term: string;
		/** The romanizer's reading where it has one, filed as `romanization`. */
		reading: string | null;
		sentence: string;
		tags?: string[];
	}

	export interface HarvestGroup {
		key: string;
		title?: string;
		href?: string;
		words: HarvestWord[];
	}
</script>

<script lang="ts">
	import { addWords, type NewWord } from '$lib/assistant';
	import { isMockMode } from '$lib/llm';
	import { glossWords } from '$lib/reading';
	import { termKey } from '$lib/text';
	import type { Profile } from '$lib/types';

	interface Props {
		profile: Profile;
		groups: HarvestGroup[];
		/** The count line, e.g. "12 words you don't have yet". */
		summary: string;
		/** After a successful add, with the ids it filed and what `addWords` said. */
		onadded: (ids: string[], summary: string) => void | Promise<void>;
		/** When given, every word has a Dismiss button. */
		ondismiss?: (id: string) => void;
	}

	let { profile, groups, summary, onadded, ondismiss }: Props = $props();

	const words = $derived(groups.flatMap((group) => group.words));

	/** Ticked words and typed or found meanings, by word id. */
	let picked = $state<Record<string, boolean>>({});
	let meanings = $state<Record<string, string>>({});
	let finding = $state(false);
	let adding = $state(false);
	let error = $state('');
	let outcome = $state('');

	const tickedCount = $derived(words.filter((word) => picked[word.id]).length);
	const needMeaning = $derived(
		words.filter((word) => picked[word.id] && !(meanings[word.id] ?? '').trim())
	);
	const toFile = $derived(
		words.flatMap((word) => {
			const meaning = (meanings[word.id] ?? '').trim();
			if (!picked[word.id] || !meaning) return [];
			const filed: NewWord = {
				term: word.term,
				meaning,
				...(word.reading ? { romanization: word.reading } : {})
			};
			return [{ id: word.id, filed }];
		})
	);

	function tickAll(on: boolean) {
		picked = Object.fromEntries(words.map((word) => [word.id, on]));
	}

	async function findMeanings() {
		if (finding || needMeaning.length === 0) return;
		const asked = needMeaning;
		finding = true;
		error = '';
		try {
			const glossed = await glossWords({
				profile: {
					nativeLanguage: profile.nativeLanguage,
					targetLanguage: profile.targetLanguage
				},
				words: asked.map((word) => ({ term: word.term, sentence: word.sentence }))
			});
			const byTerm = new Map(glossed.map((gloss) => [termKey(gloss.term), gloss.meaning]));
			const filled = { ...meanings };
			for (const word of asked) {
				const meaning = byTerm.get(termKey(word.term));
				if (meaning && !(filled[word.id] ?? '').trim()) filled[word.id] = meaning;
			}
			meanings = filled;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not find those meanings.';
		} finally {
			finding = false;
		}
	}

	async function add() {
		if (adding || toFile.length === 0) return;
		const filing = toFile;
		adding = true;
		error = '';
		outcome = '';
		try {
			const result = await addWords(filing.map((word) => word.filed));
			outcome = result.summary;
			picked = {};
			await onadded(
				filing.map((word) => word.id),
				result.summary
			);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not add those words.';
		} finally {
			adding = false;
		}
	}
</script>

<div class="bar">
	<p class="count">
		{summary}{#if tickedCount}
			· {tickedCount} ticked{/if}
	</p>
	<div class="bar-actions">
		<button
			type="button"
			class="btn btn-ghost"
			disabled={adding}
			onclick={() => tickAll(tickedCount === 0)}
		>
			{tickedCount === 0 ? 'Tick all' : 'Untick all'}
		</button>
		<button
			type="button"
			class="btn"
			disabled={finding || adding || needMeaning.length === 0}
			onclick={() => void findMeanings()}
		>
			{finding ? 'Finding meanings…' : 'Find meanings'}
		</button>
		<button
			type="button"
			class="btn btn-primary"
			disabled={adding || toFile.length === 0}
			onclick={() => void add()}
		>
			{adding ? 'Adding…' : `Add ${toFile.length} word${toFile.length === 1 ? '' : 's'}`}
		</button>
	</div>
	{#if error}
		<p class="error" role="alert">{error}</p>
	{:else if outcome}
		<p class="outcome" aria-live="polite">{outcome}</p>
	{:else if needMeaning.length > 0 && !finding}
		<p class="hint">
			{needMeaning.length} ticked word{needMeaning.length === 1 ? ' needs' : 's need'} a meaning: type
			it, or find {needMeaning.length === 1 ? 'it' : 'them'}{isMockMode()
				? ' (offline sample meanings)'
				: ''}.
		</p>
	{/if}
</div>

{#each groups as group (group.key)}
	<section class="group">
		{#if group.title}
			<h2 class="group-title">
				{#if group.href}
					<a href={group.href} target="_blank" rel="noopener noreferrer">{group.title}</a>
				{:else}
					{group.title}
				{/if}
			</h2>
		{/if}
		<ul class="words">
			{#each group.words as word (word.id)}
				<li class="word" class:is-on={picked[word.id]}>
					<div class="head">
						<label class="pick">
							<input type="checkbox" disabled={adding} bind:checked={picked[word.id]} />
							<span class="term">
								<span class="term-text">{word.term}</span>
								{#if word.reading}<span class="reading">{word.reading}</span>{/if}
								{#each word.tags ?? [] as tag (tag)}<span class="tag">{tag}</span>{/each}
							</span>
						</label>
						{#if ondismiss}
							<button
								type="button"
								class="dismiss"
								aria-label={`Dismiss ${word.term}`}
								disabled={adding}
								onclick={() => ondismiss(word.id)}>×</button
							>
						{/if}
					</div>
					<input
						class="input meaning"
						type="text"
						placeholder="Meaning"
						aria-label={`Meaning of ${word.term}`}
						disabled={adding}
						bind:value={meanings[word.id]}
						oninput={() => {
							if ((meanings[word.id] ?? '').trim()) picked[word.id] = true;
						}}
					/>
					<p class="sentence">{word.sentence}</p>
				</li>
			{/each}
		</ul>
	</section>
{/each}

<style>
	/* The actions stay in reach down a long list: a video's transcript can hold hundreds. */
	.bar {
		position: sticky;
		top: 0;
		z-index: 2;
		margin: 0 calc(-1 * var(--gutter)) 0.75rem;
		padding: 0.75rem var(--gutter);
		background: var(--bg);
		border-bottom: 1px solid var(--border);
	}

	.count {
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.bar-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.hint,
	.outcome {
		margin: 0.6rem 0 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.outcome {
		color: var(--primary-strong);
		font-weight: 700;
	}

	.error {
		margin: 0.6rem 0 0;
		padding: 0.55rem 0.8rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.group + .group {
		margin-top: 1.5rem;
	}

	.group-title {
		margin: 0 0 0.25rem;
		font-size: 1rem;
		overflow-wrap: anywhere;
	}

	.group-title a {
		color: inherit;
	}

	.words {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.25rem;
	}

	.word {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.35rem;
		padding: 0.6rem 0.25rem;
		border-bottom: 1px solid var(--border);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.pick {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
		min-height: 2.75rem;
		cursor: pointer;
	}

	.pick input {
		width: 1.25rem;
		height: 1.25rem;
		flex: none;
		accent-color: var(--primary);
	}

	.term {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.5rem;
		min-width: 0;
	}

	.term-text {
		font-size: 1.15rem;
		font-weight: 700;
	}

	.reading,
	.tag {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.dismiss {
		flex: none;
		width: 2.75rem;
		height: 2.75rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		font-size: 1.3rem;
		cursor: pointer;
	}

	.dismiss:hover {
		color: var(--text);
	}

	.sentence {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (min-width: 48rem) {
		.word {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: center;
			column-gap: 1rem;
		}

		.sentence {
			grid-column: 1 / -1;
		}
	}
</style>
