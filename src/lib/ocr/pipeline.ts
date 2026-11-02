/**
 * PP-OCR's pre- and post-processing, pure: an RGBA raster in, lines of text
 * with the x of every character boundary out. Inference is not here — the
 * engine runs the two models between these steps — so this is the part a Rust
 * crate would take over unchanged, with ONNX Runtime native on a Tauri host
 * and onnxruntime-web in a browser.
 *
 * Two models, PP-OCRv5: a detector (DB) that answers a text-probability map,
 * and a recognizer (SVTR, CTC) that reads one line crop 48px tall. The
 * detector's boxes are axis-aligned — a textbook's lines are horizontal — and
 * every character's position comes from the CTC timestep it was emitted at,
 * which is what lets a word be underlined without a font to measure.
 */

export interface Raster {
	/** RGBA, row-major, as `ImageData.data`. */
	data: Uint8ClampedArray | Uint8Array;
	width: number;
	height: number;
}

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcrLine {
	text: string;
	/** In the raster's pixels. */
	box: Box;
	/**
	 * `text.length + 1` x coordinates, raster pixels: UTF-16 unit `i` spans
	 * `[edges[i], edges[i + 1])`. A surrogate pair's two units share a span.
	 */
	edges: number[];
	/** Mean confidence of the emitted characters, 0–1. */
	score: number;
}

export interface Tensor {
	data: Float32Array;
	dims: number[];
}

/** PaddleOCR's det normalisation (ImageNet), on BGR as its cv2 reader gives. */
const DET_MEAN = [0.406, 0.456, 0.485];
const DET_STD = [0.225, 0.224, 0.229];
/** A pixel is text above this. */
const DET_THRESH = 0.3;
/** A region is kept when its mean probability clears this. */
const DET_BOX_THRESH = 0.6;
/** DB trains on regions shrunk by this much; the box grows back by it. */
const DET_UNCLIP = 1.5;
const DET_MIN_SIDE = 3;

export const REC_HEIGHT = 48;
/** Short crops are padded to this, as PaddleOCR's default 320×48 shape is. */
const REC_MIN_WIDTH = 160;

/** Bilinear sample of channel `c` at a fractional position, edge-clamped. */
function sample(raster: Raster, x: number, y: number, c: number): number {
	const { data, width, height } = raster;
	const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
	const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
	const x1 = Math.min(width - 1, x0 + 1);
	const y1 = Math.min(height - 1, y0 + 1);
	const fx = Math.max(0, Math.min(1, x - x0));
	const fy = Math.max(0, Math.min(1, y - y0));
	const at = (xx: number, yy: number) => data[(yy * width + xx) * 4 + c];
	const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
	const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
	return top * (1 - fy) + bottom * fy;
}

export interface DetInput extends Tensor {
	/** Detector pixels per raster pixel, per axis. */
	sx: number;
	sy: number;
}

/**
 * The page scaled so its long side is at most `limit`, each side a multiple of
 * 32 (the detector's stride), as a `[1, 3, h, w]` BGR tensor.
 */
export function detInput(raster: Raster, limit = 1536): DetInput {
	const scale = Math.min(1, limit / Math.max(raster.width, raster.height));
	const w = Math.max(32, Math.round((raster.width * scale) / 32) * 32);
	const h = Math.max(32, Math.round((raster.height * scale) / 32) * 32);
	const sx = w / raster.width;
	const sy = h / raster.height;
	const plane = w * h;
	const data = new Float32Array(3 * plane);
	for (let y = 0; y < h; y++) {
		const ry = (y + 0.5) / sy - 0.5;
		for (let x = 0; x < w; x++) {
			const rx = (x + 0.5) / sx - 0.5;
			for (let c = 0; c < 3; c++) {
				// Tensor channel c is BGR: c=0 reads the raster's blue.
				const v = sample(raster, rx, ry, 2 - c) / 255;
				data[c * plane + y * w + x] = (v - DET_MEAN[c]) / DET_STD[c];
			}
		}
	}
	return { data, dims: [1, 3, h, w], sx, sy };
}

/**
 * Text regions in the detector's probability map, back in raster pixels:
 * 4-connected components over the threshold, each region's bounding box grown
 * by DB's unclip distance. Sorted top to bottom, then left to right.
 */
export function detBoxes(map: Tensor, input: DetInput, raster: Raster): Box[] {
	const h = map.dims[2];
	const w = map.dims[3];
	const prob = map.data;
	const seen = new Uint8Array(w * h);
	const stack: number[] = [];
	const boxes: Box[] = [];
	for (let start = 0; start < w * h; start++) {
		if (seen[start] || prob[start] <= DET_THRESH) continue;
		let minX = w;
		let minY = h;
		let maxX = -1;
		let maxY = -1;
		let sum = 0;
		let count = 0;
		seen[start] = 1;
		stack.push(start);
		while (stack.length) {
			const i = stack.pop()!;
			const x = i % w;
			const y = (i - x) / w;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
			sum += prob[i];
			count++;
			const next = [
				x > 0 ? i - 1 : -1,
				x < w - 1 ? i + 1 : -1,
				y > 0 ? i - w : -1,
				y < h - 1 ? i + w : -1
			];
			for (const j of next) {
				if (j >= 0 && !seen[j] && prob[j] > DET_THRESH) {
					seen[j] = 1;
					stack.push(j);
				}
			}
		}
		const bw = maxX - minX + 1;
		const bh = maxY - minY + 1;
		if (Math.min(bw, bh) < DET_MIN_SIDE || sum / count < DET_BOX_THRESH) continue;
		const d = (bw * bh * DET_UNCLIP) / (2 * (bw + bh));
		const x0 = Math.max(0, (minX - d) / input.sx);
		const y0 = Math.max(0, (minY - d) / input.sy);
		const x1 = Math.min(raster.width, (maxX + 1 + d) / input.sx);
		const y1 = Math.min(raster.height, (maxY + 1 + d) / input.sy);
		boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
	}
	// Rows first: two boxes whose vertical centres are within half a line are on
	// the same row and go left to right.
	return boxes.sort((a, b) => {
		const dy = a.y + a.h / 2 - (b.y + b.h / 2);
		return Math.abs(dy) < Math.min(a.h, b.h) / 2 ? a.x - b.x : dy;
	});
}

export interface RecInput extends Tensor {
	/** The width the crop itself occupies, before padding. */
	contentWidth: number;
}

/** One box cut out at `REC_HEIGHT`, aspect kept, right-padded with zeros. */
export function recInput(raster: Raster, box: Box): RecInput {
	const scale = REC_HEIGHT / box.h;
	const contentWidth = Math.max(1, Math.round(box.w * scale));
	const w = Math.max(REC_MIN_WIDTH, Math.ceil(contentWidth / 8) * 8);
	const plane = REC_HEIGHT * w;
	const data = new Float32Array(3 * plane);
	for (let y = 0; y < REC_HEIGHT; y++) {
		const ry = box.y + (y + 0.5) / scale - 0.5;
		for (let x = 0; x < contentWidth; x++) {
			const rx = box.x + (x + 0.5) / scale - 0.5;
			for (let c = 0; c < 3; c++) {
				const v = sample(raster, rx, ry, 2 - c) / 255;
				data[c * plane + y * w + x] = (v - 0.5) / 0.5;
			}
		}
	}
	return { data, dims: [1, 3, REC_HEIGHT, w], contentWidth };
}

/**
 * Greedy CTC over `[1, T, C]` logits: class 0 is the blank, `1..=dict.length`
 * the dictionary, the last a space. Each character's x is the centre of the
 * timesteps that emitted it, mapped back through the crop; a boundary is the
 * midpoint between two centres, the line's ends the box's.
 */
export function recDecode(out: Tensor, input: RecInput, box: Box, dict: string[]): OcrLine {
	const steps = out.dims[1];
	const classes = out.dims[2];
	const stepWidth = input.dims[3] / steps;
	const scale = box.h / REC_HEIGHT;
	const chars: { text: string; centre: number; prob: number }[] = [];
	let prev = 0;
	let runStart = 0;
	for (let t = 0; t <= steps; t++) {
		let best = 0;
		let bestP = -Infinity;
		if (t < steps) {
			const row = t * classes;
			for (let k = 0; k < classes; k++) {
				const p = out.data[row + k];
				if (p > bestP) {
					bestP = p;
					best = k;
				}
			}
		}
		if (t < steps && best === prev) continue;
		// The run of `prev` that ended at t is one character.
		if (prev !== 0 && t > 0) {
			const centre = ((runStart + t) / 2) * stepWidth;
			const text = prev <= dict.length ? dict[prev - 1] : ' ';
			chars.at(-1)!.centre = box.x + centre * scale;
			chars.at(-1)!.text = text;
		}
		if (t < steps && best !== 0) chars.push({ text: '', centre: 0, prob: bestP });
		prev = best;
		runStart = t;
	}
	let text = '';
	const edges: number[] = [box.x];
	chars.forEach((char, i) => {
		const right = i + 1 < chars.length ? (char.centre + chars[i + 1].centre) / 2 : box.x + box.w;
		text += char.text;
		// Every UTF-16 unit of the character ends at the same boundary.
		for (let u = 0; u < char.text.length; u++) edges.push(right);
	});
	const score = chars.length ? chars.reduce((s, c) => s + c.prob, 0) / chars.length : 0;
	return { text, box, edges, score };
}
