<!--
  A small non-modal dialog anchored at a tapped word: the word card's home at
  ≥48rem in the reader and the page viewer (a phone keeps its sheet).

  Positioned by `@floating-ui/dom` rather than CSS anchor positioning, which
  neither Firefox nor WebKitGTK (the Tauri shell) can be relied on for:
  above the word by preference, below when there is no room, shifted inside
  the viewport, and kept attached by `autoUpdate` while any scroll container
  around the word scrolls — pdf.js's container, the reader's columns. Fixed
  strategy, so no column's `overflow` clips it; it is hidden while the word is
  scrolled out of its container.

  It asks to close on Esc and on a click outside (a drag is not a click; the
  word itself is inside), and when the word's element leaves the DOM. However
  it closes, focus that was in here goes back to the word, if the word is
  still there — a click that put focus elsewhere keeps it there. Focus moves
  in once it is first shown: the `[data-autofocus]` element, else the first
  button.
-->
<script lang="ts">
	import { arrow, autoUpdate, computePosition, flip, hide, offset, shift } from '@floating-ui/dom';
	import type { Snippet } from 'svelte';

	interface Props {
		/** The word's own element. */
		anchor: HTMLElement;
		label: string;
		onclose: () => void;
		children: Snippet;
	}

	let { anchor, label, onclose, children }: Props = $props();

	let box = $state<HTMLDivElement | null>(null);
	let tip = $state<HTMLSpanElement | null>(null);
	let side = $state<'top' | 'bottom'>('top');

	$effect(() => {
		const floating = box;
		const reference = anchor;
		const point = tip;
		if (!floating || !point) return;
		let focused = false;
		const update = () => {
			if (!reference.isConnected) return;
			void computePosition(reference, floating, {
				strategy: 'fixed',
				placement: 'top',
				middleware: [
					offset(10),
					flip({ fallbackPlacements: ['bottom'] }),
					shift({ padding: 8 }),
					arrow({ element: point, padding: 12 }),
					hide()
				]
			}).then(({ x, y, placement, middlewareData }) => {
				const hidden = middlewareData.hide?.referenceHidden ?? false;
				Object.assign(floating.style, {
					left: `${x}px`,
					top: `${y}px`,
					visibility: hidden ? 'hidden' : 'visible'
				});
				side = placement.startsWith('bottom') ? 'bottom' : 'top';
				const at = middlewareData.arrow;
				point.style.left = at?.x !== undefined ? `${at.x}px` : '';
				if (!hidden && !focused) {
					focused = true;
					const first =
						floating.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ??
						floating.querySelector<HTMLElement>('button:not(:disabled)');
					first?.focus({ preventScroll: true });
				}
			});
		};
		return autoUpdate(reference, floating, update);
	});

	// The word gone from the page (a re-render, a page reset): nothing to point at.
	$effect(() => {
		const reference = anchor;
		const observer = new MutationObserver(() => {
			if (!reference.isConnected) onclose();
		});
		observer.observe(document.body, { childList: true, subtree: true });
		return () => observer.disconnect();
	});

	$effect(() => {
		const reference = anchor;
		let down: { x: number; y: number } | undefined;
		const onDown = (event: PointerEvent) => {
			down = { x: event.clientX, y: event.clientY };
		};
		// Capture, so this runs before the clicked control's own handler: a click
		// on another word closes this one first and then opens that one.
		const onClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			const dragged = down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
			down = undefined;
			if (dragged || !target || box?.contains(target) || reference.contains(target)) return;
			onclose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onclose();
		};
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('click', onClick, true);
		window.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('click', onClick, true);
			window.removeEventListener('keydown', onKey);
		};
	});

	// On the way out, focus left in here (or dropped to the body with it) goes
	// back to the word.
	$effect(() => {
		const el = box;
		if (!el) return;
		return () => {
			const active = document.activeElement;
			const inside = !active || active === document.body || el.contains(active);
			if (inside && anchor.isConnected) anchor.focus({ preventScroll: true });
		};
	});
</script>

<div class="word-popover" role="dialog" aria-label={label} data-side={side} bind:this={box}>
	<span class="tip" aria-hidden="true" bind:this={tip}></span>
	<div class="body">
		{@render children()}
	</div>
</div>

<style>
	/* The app's card skin, compact. Hidden until it is first placed, so it never
	   flashes at the corner of the screen. */
	.word-popover {
		position: fixed;
		top: 0;
		left: 0;
		z-index: 40;
		width: min(20rem, calc(100vw - 1rem));
		visibility: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		box-shadow: var(--shadow);
	}

	.body {
		max-height: min(70dvh, 32rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0.85rem 1rem 1rem;
		border-radius: inherit;
	}

	/* A small square turned on its corner, on the side facing the word. */
	.tip {
		position: absolute;
		width: 0.75rem;
		height: 0.75rem;
		border: 1px solid var(--border);
		background: var(--surface);
		transform: rotate(45deg);
	}

	.word-popover[data-side='top'] .tip {
		bottom: calc(-0.375rem - 1px);
		border-top: 0;
		border-left: 0;
	}

	.word-popover[data-side='bottom'] .tip {
		top: calc(-0.375rem - 1px);
		border-bottom: 0;
		border-right: 0;
	}
</style>
