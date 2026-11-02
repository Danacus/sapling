import { describe, expect, it } from 'vitest';

import { linesOfItems } from './pdf';
import { detBoxes, detInput, recDecode, REC_HEIGHT, type Raster } from './pipeline';

function blank(width: number, height: number): Raster {
	return { data: new Uint8ClampedArray(width * height * 4).fill(255), width, height };
}

/** `[1, T, C]` logits with class `path[t]` winning at each step. */
function logits(path: number[], classes: number) {
	const data = new Float32Array(path.length * classes);
	path.forEach((k, t) => (data[t * classes + k] = 0.9));
	return { data, dims: [1, path.length, classes] };
}

describe('recDecode', () => {
	const dict = ['你', '好', '吗'];
	const classes = dict.length + 2; // blank, the dictionary, a space

	it('collapses repeats, drops blanks and reads the last class as a space', () => {
		const out = logits([0, 1, 1, 0, 2, 0, 4, 3, 3, 0], classes);
		const input = { data: new Float32Array(), dims: [1, 3, REC_HEIGHT, 80], contentWidth: 80 };
		const line = recDecode(out, input, { x: 0, y: 0, w: 80, h: REC_HEIGHT }, dict);
		expect(line.text).toBe('你好 吗');
		expect(line.score).toBeCloseTo(0.9);
	});

	it('places each character at the centre of the steps that emitted it', () => {
		// 10 steps over an 80px crop at scale 1: 8px a step, the box at x=100.
		const out = logits([1, 1, 0, 0, 0, 0, 0, 0, 2, 2], classes);
		const input = { data: new Float32Array(), dims: [1, 3, REC_HEIGHT, 80], contentWidth: 80 };
		const line = recDecode(out, input, { x: 100, y: 0, w: 80, h: REC_HEIGHT }, dict);
		expect(line.text).toBe('你好');
		// 你 is steps 0–1 (centre 8px), 好 steps 8–9 (centre 72px); the boundary
		// between them is the midpoint, the ends are the box's.
		expect(line.edges).toEqual([100, 140, 180]);
	});

	it('maps positions back through the crop scale', () => {
		const out = logits([1, 0, 0, 2], classes);
		const input = { data: new Float32Array(), dims: [1, 3, REC_HEIGHT, 32], contentWidth: 32 };
		// A box twice the crop's height: every crop pixel is two page pixels.
		const line = recDecode(out, input, { x: 0, y: 0, w: 64, h: REC_HEIGHT * 2 }, dict);
		expect(line.edges).toEqual([0, 32, 64]);
	});
});

describe('detBoxes', () => {
	it('finds each region over the threshold and grows it back by the unclip distance', () => {
		const raster = blank(64, 32);
		const input = detInput(raster);
		const [, , h, w] = input.dims;
		const map = new Float32Array(w * h);
		// One 20×4 region at (10, 10), and a lone faint pixel that must be dropped.
		for (let y = 10; y < 14; y++) for (let x = 10; x < 30; x++) map[y * w + x] = 0.9;
		map[2 * w + 50] = 0.4;
		const boxes = detBoxes({ data: map, dims: [1, 1, h, w] }, input, raster);
		expect(boxes).toHaveLength(1);
		const d = (20 * 4 * 1.5) / (2 * 24);
		expect(boxes[0].x).toBeCloseTo(10 - d);
		expect(boxes[0].w).toBeCloseTo(20 + 2 * d);
	});

	it('orders a row left to right before the next row', () => {
		const raster = blank(64, 64);
		const input = detInput(raster);
		const [, , h, w] = input.dims;
		const map = new Float32Array(w * h);
		const fill = (x0: number, y0: number) => {
			for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 10; x++) map[y * w + x] = 0.9;
		};
		fill(40, 41); // second row
		fill(40, 11); // first row, right
		fill(5, 12); // first row, left, a pixel lower
		const boxes = detBoxes({ data: map, dims: [1, 1, h, w] }, input, raster);
		expect(boxes.map((b) => Math.round(b.x + b.w / 2))).toEqual([10, 45, 45]);
		expect(boxes[2].y).toBeGreaterThan(boxes[1].y);
	});
});

describe('linesOfItems', () => {
	const identity = (m: number[]) => m;

	it('joins items on one baseline and spaces evenly inside an item', () => {
		const lines = linesOfItems(
			[
				{ str: '你好', transform: [10, 0, 0, 10, 0, 100], width: 20 },
				{ str: '吗', transform: [10, 0, 0, 10, 20, 100], width: 10 }
			],
			identity,
			1
		);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe('你好吗');
		expect(lines[0].edges).toEqual([0, 10, 20, 30]);
	});

	it('puts a space in a wide gap and starts a new line on a new baseline', () => {
		const lines = linesOfItems(
			[
				{ str: 'Read', transform: [10, 0, 0, 10, 0, 100], width: 20 },
				{ str: 'aloud', transform: [10, 0, 0, 10, 30, 100], width: 25 },
				{ str: 'Next', transform: [10, 0, 0, 10, 0, 130], width: 20 }
			],
			identity,
			1
		);
		expect(lines.map((line) => line.text)).toEqual(['Read aloud', 'Next']);
		expect(lines[0].edges).toHaveLength('Read aloud'.length + 1);
		expect(lines[0].edges[5]).toBe(30);
	});
});
