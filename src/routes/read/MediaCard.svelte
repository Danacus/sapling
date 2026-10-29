<!--
  One text on the library's grid: the whole card is one link to the reader.

  The tile on top is what the text *is* at a glance — a YouTube video's own
  thumbnail, a play glyph on a dark tile for a recording we only know by name
  (or a thumbnail that could not load: offline is ordinary here), and for a
  text with no recording the opening lines themselves, fading out. The badge
  says where it came from and the chip how long it runs; under the tile, the
  title and the same extent and date the reader would tell you.

  The thumbnail is the one request this page makes to anyone: `i.ytimg.com`,
  with no referrer, for a video the learner chose (`media.md`).
-->
<script module lang="ts">
	const dates = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});
</script>

<script lang="ts">
	import type { ReadingText } from '$lib/types';

	import { SOURCE_NAMES, duration, excerpt, extent, sourceOf } from './compose';

	interface Props {
		text: ReadingText;
	}

	let { text }: Props = $props();

	const kind = $derived(sourceOf(text));
	const videoId = $derived(text.media?.kind === 'youtube' ? text.media.videoId : undefined);
	/** A thumbnail that failed (offline, blocked) falls back to the plain tile. */
	let thumbFailed = $state(false);
	const runs = $derived(text.media ? duration(text.segments) : undefined);
	const opening = $derived(text.media ? '' : excerpt(text.segments));
</script>

<a class="media-card" href="/read/{text.id}">
	<span class="tile" class:is-text={!text.media}>
		{#if videoId && !thumbFailed}
			<img
				class="thumb"
				src="https://i.ytimg.com/vi/{videoId}/mqdefault.jpg"
				alt=""
				loading="lazy"
				referrerpolicy="no-referrer"
				onerror={() => (thumbFailed = true)}
			/>
		{:else if text.media}
			<span class="still" aria-hidden="true">
				<svg class="play" viewBox="0 0 24 24">
					<path
						d="M8.6 6.4v11.2a.6.6 0 0 0 .92.5l8.6-5.6a.6.6 0 0 0 0-1L9.52 5.9a.6.6 0 0 0-.92.5z"
					/>
				</svg>
			</span>
		{:else}
			<span class="excerpt" aria-hidden="true">{opening}</span>
		{/if}

		<span class="badge badge-{kind}" class:on-picture={!!text.media}>{SOURCE_NAMES[kind]}</span>
		{#if runs}
			<span class="runs">{runs}</span>
		{/if}
	</span>

	<span class="title">{text.title}</span>
	<span class="meta">
		<span>{extent(text.segments)}</span>
		<span aria-hidden="true">·</span>
		<span>{dates.format(text.createdAt)}</span>
	</span>
</a>

<style>
	/* Dressed as the old shelf row was — same border, hover and ring — so the
	   card reads as the same object at a new size. */
	.media-card {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 0.5rem 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.media-card:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.media-card:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* The picture. Fixed tones rather than theme tokens for everything laid
	   over it: a thumbnail is the same image in either theme, so a pill that
	   inverted with the theme would vanish into half of them. */
	.tile {
		position: relative;
		display: block;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: #333b2b;
	}

	.thumb {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.still {
		display: grid;
		place-items: center;
		width: 100%;
		height: 100%;
	}

	.play {
		width: 2.4rem;
		height: 2.4rem;
		fill: rgb(253 251 245 / 82%);
	}

	/* A text's tile is a scrap of the page itself: paper, the display serif,
	   and the end faded rather than cut, so it reads as more to come. */
	.tile.is-text {
		background: var(--surface-alt);
	}

	.excerpt {
		display: block;
		height: 100%;
		padding: 2rem 0.7rem 0;
		font-family: var(--font-display);
		font-size: 0.78rem;
		line-height: 1.4;
		color: color-mix(in srgb, var(--text) 80%, var(--text-muted));
		overflow-wrap: anywhere;
		mask-image: linear-gradient(to bottom, #000 45%, transparent 95%);
	}

	/* Same two hues the shelf used: an imported text and a written one are
	   peers, so they differ in hue, not in weight. */
	.badge {
		position: absolute;
		top: 0.4rem;
		left: 0.4rem;
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		font-size: 0.64rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.badge-generated {
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.badge-imported {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.badge.on-picture {
		background: rgb(253 251 245 / 92%);
		color: #26301f;
	}

	.runs {
		position: absolute;
		right: 0.4rem;
		bottom: 0.4rem;
		padding: 0.05rem 0.4rem;
		border-radius: var(--radius-sm);
		background: rgb(20 24 15 / 80%);
		color: #fdfbf5;
		font-size: 0.7rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.title {
		display: -webkit-box;
		margin: 0.6rem 0.2rem 0;
		overflow: hidden;
		font-family: var(--font-display);
		font-size: 0.98rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		line-height: 1.25;
		overflow-wrap: anywhere;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 0.35rem;
		margin: 0.3rem 0.2rem 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}
</style>
