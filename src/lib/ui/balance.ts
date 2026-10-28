/**
 * Two balanced columns in source order, the same in every engine. CSS
 * multi-column balances unbreakable blocks differently per engine (WebKitGTK
 * and Chrome leave them far apart), so `.spread-flow` is a column-direction
 * flex-wrap instead, and this action gives it the one height that makes it
 * wrap after the right child: the taller column of the best contiguous split.
 */

export interface ColumnSplit {
	/** How many leading items go in the first column. */
	split: number;
	/** The container height that wraps exactly after `split` items. */
	height: number;
}

const columnHeight = (heights: readonly number[], from: number, to: number, gap: number) =>
	to > from ? heights.slice(from, to).reduce((sum, h) => sum + h, 0) + gap * (to - from - 1) : 0;

/**
 * The split minimising the taller column. Ties go to the larger split, which
 * guarantees the next item overflows the first column; the height then adds
 * up to a pixel of slack (never as much as that overflow) so layout-unit
 * rounding can neither push the last item of a column over nor pull the next
 * one in.
 */
export function splitColumns(heights: readonly number[], gap: number): ColumnSplit {
	let best = { split: heights.length, tallest: columnHeight(heights, 0, heights.length, gap) };
	for (let split = heights.length - 1; split >= 0; split--) {
		const tallest = Math.max(
			columnHeight(heights, 0, split, gap),
			columnHeight(heights, split, heights.length, gap)
		);
		if (tallest < best.tallest) best = { split, tallest };
	}
	const { split, tallest } = best;
	const overflow =
		split < heights.length ? columnHeight(heights, 0, split + 1, gap) - tallest : Infinity;
	return { split, height: tallest + Math.min(1, overflow / 2) };
}

const WIDE = '(min-width: 48rem)';

/** `use:balanceColumns` on a `.spread-flow`; inert below the wide breakpoint. */
export function balanceColumns(node: HTMLElement) {
	const wide = matchMedia(WIDE);
	let frame = 0;

	const measure = () => {
		frame = 0;
		if (!wide.matches) {
			node.style.removeProperty('--flow-height');
			return;
		}
		// getBoundingClientRect includes transforms, but `ll-rise` only
		// translates, so the heights are the laid-out ones.
		const heights = [...node.children].map((child) => child.getBoundingClientRect().height);
		const gap = parseFloat(getComputedStyle(node).rowGap) || 0;
		node.style.setProperty('--flow-height', `${splitColumns(heights, gap).height}px`);
	};

	// Deferred a frame: resizing the container from inside its own observer's
	// callback would trip the "loop completed with undelivered notifications" error.
	const schedule = () => {
		if (!frame) frame = requestAnimationFrame(measure);
	};

	const resizes = new ResizeObserver(schedule);
	const observeAll = () => {
		resizes.disconnect();
		resizes.observe(node);
		for (const child of node.children) resizes.observe(child);
	};
	const mutations = new MutationObserver(() => {
		observeAll();
		schedule();
	});

	observeAll();
	mutations.observe(node, { childList: true });
	wide.addEventListener('change', schedule);
	measure();

	return {
		destroy() {
			if (frame) cancelAnimationFrame(frame);
			resizes.disconnect();
			mutations.disconnect();
			wide.removeEventListener('change', schedule);
			node.style.removeProperty('--flow-height');
		}
	};
}
