/**
 * A PDF (or a page image) as pages the viewer can draw and read: each page a
 * raster for the screen and for OCR, and — where the PDF has real text — the
 * lines pdf.js finds in it, in the same shape OCR answers, so the overlay
 * never knows which it got.
 */
import type { OcrLine, Raster } from './pipeline';

/** The long side a page is drawn at: sharp on a laptop, and what OCR reads. */
const LONG_SIDE = 1800;

export interface ViewerPage {
	raster: Raster;
	/** The page as the screen shows it, at the raster's size. */
	url: string;
	/** pdf.js's text, empty for an image or a PDF whose text is drawn, not encoded. */
	textLines: OcrLine[];
}

/** The long side a thumbnail is drawn at: a rail of nearby pages, not reading. */
const THUMB_SIDE = 160;

export interface ViewerDocument {
	count: number;
	page(n: number): Promise<ViewerPage>;
	/** Page `n` small, as an object URL the caller revokes; no text, no raster. */
	thumbnail(n: number): Promise<string>;
	close(): void;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width));
	canvas.height = Math.max(1, Math.round(height));
	return canvas;
}

function rasterOf(canvas: HTMLCanvasElement): Raster {
	const context = canvas.getContext('2d')!;
	const image = context.getImageData(0, 0, canvas.width, canvas.height);
	return { data: image.data, width: image.width, height: image.height };
}

function blobUrl(canvas: HTMLCanvasElement): Promise<string> {
	return new Promise((resolve, reject) =>
		canvas.toBlob(
			(blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error('No page image.'))),
			'image/jpeg',
			0.9
		)
	);
}

interface TextItemLike {
	str: string;
	transform: number[];
	width: number;
	hasEOL?: boolean;
}

/**
 * pdf.js text items, joined into lines: items on one baseline that continue
 * left to right are one line, a gap wider than a quarter em becomes a space.
 * Inside an item the characters are spaced evenly — glyph widths would need
 * the font, and an underline only needs to be close.
 */
export function linesOfItems(
	items: TextItemLike[],
	toViewport: (m: number[]) => number[],
	scale: number
): OcrLine[] {
	const lines: (OcrLine & { baseline: number; size: number })[] = [];
	for (const item of items) {
		if (!item.str) continue;
		const m = toViewport(item.transform);
		const size = Math.hypot(m[2], m[3]);
		const x = m[4];
		const baseline = m[5];
		const width = item.width * scale;
		if (size <= 0 || width <= 0) continue;
		const last = lines.at(-1);
		const right = last ? last.box.x + last.box.w : 0;
		const continues =
			last &&
			Math.abs(last.baseline - baseline) < Math.min(size, last.size) / 2 &&
			x > right - size / 2;
		let line = last;
		if (!continues || !line) {
			line = {
				text: '',
				box: { x, y: baseline - size * 0.95, w: 0, h: size * 1.2 },
				edges: [x],
				score: 1,
				baseline,
				size
			};
			lines.push(line);
		} else if (x - right > size / 4 && !/\s$/.test(line.text) && !/^\s/.test(item.str)) {
			line.text += ' ';
			line.edges.push(x);
		}
		const step = width / item.str.length;
		for (let i = 0; i < item.str.length; i++) {
			line.text += item.str[i];
			line.edges.push(x + step * (i + 1));
		}
		line.box.w = x + width - line.box.x;
		line.box.y = Math.min(line.box.y, baseline - size * 0.95);
	}
	return lines
		.filter((line) => line.text.trim())
		.map(({ text, box, edges, score }) => ({ text, box, edges, score }));
}

async function pdfDocument(file: File): Promise<ViewerDocument> {
	const pdfjs = await import('pdfjs-dist');
	const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const doc = await pdfjs.getDocument({
		data: new Uint8Array(await file.arrayBuffer()),
		// The JBIG2 and JPEG 2000 decoders, which scans are often encoded in: from
		// the CDN at the installed version, as ONNX Runtime's wasm is.
		wasmUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/wasm/`
	}).promise;
	return {
		count: doc.numPages,
		async page(n) {
			const page = await doc.getPage(n);
			const natural = page.getViewport({ scale: 1 });
			const scale = Math.min(4, Math.max(1, LONG_SIDE / Math.max(natural.width, natural.height)));
			const viewport = page.getViewport({ scale });
			const canvas = canvasOf(viewport.width, viewport.height);
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#fff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvas, canvasContext: context, viewport }).promise;
			const content = await page.getTextContent();
			const items = content.items.flatMap((item) => ('str' in item ? [item as TextItemLike] : []));
			const textLines = linesOfItems(
				items,
				(m) => pdfjs.Util.transform(viewport.transform, m),
				viewport.scale
			);
			page.cleanup();
			return { raster: rasterOf(canvas), url: await blobUrl(canvas), textLines };
		},
		async thumbnail(n) {
			const page = await doc.getPage(n);
			const natural = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({
				scale: THUMB_SIDE / Math.max(natural.width, natural.height)
			});
			const canvas = canvasOf(viewport.width, viewport.height);
			const context = canvas.getContext('2d')!;
			context.fillStyle = '#fff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvas, canvasContext: context, viewport }).promise;
			return blobUrl(canvas);
		},
		close() {
			void doc.loadingTask.destroy();
		}
	};
}

async function imageDocument(files: File[]): Promise<ViewerDocument> {
	return {
		count: files.length,
		async page(n) {
			const bitmap = await createImageBitmap(files[n - 1]);
			const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
			const canvas = canvasOf(bitmap.width * scale, bitmap.height * scale);
			canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			bitmap.close();
			return { raster: rasterOf(canvas), url: await blobUrl(canvas), textLines: [] };
		},
		async thumbnail(n) {
			const bitmap = await createImageBitmap(files[n - 1]);
			const scale = Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
			const canvas = canvasOf(bitmap.width * scale, bitmap.height * scale);
			canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			bitmap.close();
			return blobUrl(canvas);
		},
		close() {}
	};
}

export function isPdf(file: File): boolean {
	return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** One PDF, or one image per page. */
export function openDocument(files: File[]): Promise<ViewerDocument> {
	return files.length === 1 && isPdf(files[0]) ? pdfDocument(files[0]) : imageDocument(files);
}
