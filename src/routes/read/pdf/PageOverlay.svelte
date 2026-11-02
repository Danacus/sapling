<!--
  The learner's words over one printed page: a transparent button on each
  word's glyphs wearing the garden's underline, a dashed box round a line the
  recognizer was unsure of, and with `?debug` every line it read. Mounted by
  the page into pdf.js's own `div.page`, so everything is in percentages of
  the page and a zoom moves nothing; the colours (`--u-*`) are inherited from
  the viewer's `<main>`.
-->
<script lang="ts">
	import type { ReadingWord } from '$lib/reading';
	import type { PageBox, PlacedWord } from './viewer';

	interface Props {
		marks: PlacedWord[];
		unsure: PageBox[];
		/** Every line's box, drawn only under `?debug`. */
		debugLines: PageBox[];
		/** The open word, when it is on this page. */
		open?: { line: number; offset: number };
		onpick: (line: number, offset: number) => void;
	}

	let { marks, unsure, debugLines, open, onpick }: Props = $props();

	function wordClass(word: ReadingWord): string {
		return `w-${word.status}${word.maturity ? ` w-${word.maturity}` : ''}`;
	}
</script>

<div class="overlay">
	{#each unsure as box, i (i)}
		<span
			class="unsure-box"
			style:left="{box.left}%"
			style:top="{box.top}%"
			style:width="{box.width}%"
			style:height="{box.height}%"
		></span>
	{/each}
	{#each debugLines as box, i (i)}
		<span
			class="line-box"
			style:left="{box.left}%"
			style:top="{box.top}%"
			style:width="{box.width}%"
			style:height="{box.height}%"
		></span>
	{/each}
	{#each marks as at, i (i)}
		<button
			type="button"
			class="w {wordClass(at.word)}"
			class:open={open?.line === at.line && open.offset === at.offset}
			style:left="{at.left}%"
			style:top="{at.top}%"
			style:width="{at.width}%"
			style:height="{at.height}%"
			aria-label={at.word.text}
			onclick={() => onpick(at.line, at.offset)}
		></button>
	{/each}
</div>

<style>
	/* Over the canvas, under nothing: pdf.js's layers are off. */
	.overlay {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
	}

	.line-box {
		position: absolute;
		border: 1px solid rgb(0 120 255 / 50%);
	}

	/* A line the recognizer was unsure of: outlined, not interactive. */
	.unsure-box {
		position: absolute;
		border-radius: 3px;
		outline: 1.5px dashed var(--accent);
		outline-offset: 2px;
	}

	/* A word is a transparent button over the printed glyphs; the underline is
	   its bottom edge, which descenders cross as they would a ruled line.
	   Stronger than the reader's softened underlines: these sit on a printed
	   page, not on our own type. */
	.w {
		position: absolute;
		padding: 0;
		border: 0;
		border-radius: 2px;
		background: transparent;
		cursor: pointer;
		pointer-events: auto;
	}

	.w:hover,
	.w.open {
		background: color-mix(in srgb, var(--primary) 18%, transparent);
	}

	.w:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 1px;
	}

	.w.w-tracked {
		border-bottom: 3px solid var(--u-solid);
	}

	.w.w-young {
		border-bottom-color: var(--u-young);
	}

	.w.w-new {
		border-bottom-color: var(--u-new);
	}
</style>
