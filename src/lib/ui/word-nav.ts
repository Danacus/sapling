/**
 * Where ← and → take an open word card, and where a word scrolled out of its
 * container has to be brought back to — the two pure questions the reader's
 * and the page viewer's word popover ask. Words are positions (a line and an
 * index into it), because both screens hold the open word as a position.
 */

/** A word's position: line `line`, token `word` of it. */
export interface WordAt {
	line: number;
	word: number;
}

/**
 * The next (`dir` 1) or previous (`dir` -1) tappable token after `at`, across
 * lines, within lines `[range.start, range.end)` — a page, never the whole
 * text. A token is tappable when it has a `key`. `undefined` at either end.
 */
export function stepWord(
	lines: readonly (readonly { key?: string }[])[],
	at: WordAt,
	dir: 1 | -1,
	range: { start: number; end: number } = { start: 0, end: lines.length }
): WordAt | undefined {
	const end = Math.min(range.end, lines.length);
	let line = at.line;
	let word = at.word + dir;
	while (line >= range.start && line < end) {
		const words = lines[line] ?? [];
		if (dir < 0 && word >= words.length) word = words.length - 1;
		for (; word >= 0 && word < words.length; word += dir) {
			if (words[word]?.key !== undefined) return { line, word };
		}
		line += dir;
		word = dir > 0 ? 0 : Number.MAX_SAFE_INTEGER;
	}
	return undefined;
}

/** A box in viewport pixels. */
export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * How far to scroll a container (`view`) so `target` sits inside it with
 * `margin` to spare: nothing on an axis where it already does, else enough to
 * centre it on that axis, so a popover above or below it has room too.
 */
export function revealDelta(view: Box, target: Box, margin = 0): { x: number; y: number } {
	const axis = (start: number, size: number, at: number, length: number) =>
		at >= start + margin && at + length <= start + size - margin
			? 0
			: at + length / 2 - (start + size / 2);
	return {
		x: axis(view.left, view.width, target.left, target.width),
		y: axis(view.top, view.height, target.top, target.height)
	};
}
