/**
 * A textbook's pages as images a vision model can read: the pages of a PDF,
 * or photos and scans the learner picked one file per page.
 *
 * Browser-only (a canvas draws every page), and nothing is kept: a page is
 * rendered when the import asks for it and handed on as a `data:` URL. pdf.js
 * is imported on first use, so the Media page pays nothing for it until a PDF
 * is opened.
 */

/** The long side a page is drawn at. Measured scans were 800–1100px wide and read well. */
const LONG_SIDE = 1800;
const JPEG_QUALITY = 0.85;

export interface PageSource {
	/** How many pages there are to pick from. */
	count: number;
	/** Page `n` (from 1) as a JPEG `data:` URL. */
	render(n: number): Promise<string>;
	/** Lets go of the parsed document. */
	close(): void;
}

export function isPdf(file: File): boolean {
	return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function toJpeg(canvas: HTMLCanvasElement): string {
	return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = Math.max(1, Math.round(width));
	canvas.height = Math.max(1, Math.round(height));
	return canvas;
}

async function pdfSource(file: File): Promise<PageSource> {
	const pdfjs = await import('pdfjs-dist');
	const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
	pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
	const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
		.promise;
	return {
		count: document.numPages,
		async render(n) {
			const page = await document.getPage(n);
			const natural = page.getViewport({ scale: 1 });
			const scale = Math.min(4, Math.max(1, LONG_SIDE / Math.max(natural.width, natural.height)));
			const viewport = page.getViewport({ scale });
			const canvas = canvasOf(viewport.width, viewport.height);
			const context = canvas.getContext('2d');
			if (!context) throw new Error('This browser cannot draw the page.');
			// White under the page: a transparent PDF background is black as JPEG.
			context.fillStyle = '#fff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvas, canvasContext: context, viewport }).promise;
			page.cleanup();
			return toJpeg(canvas);
		},
		close() {
			// pdf.js 6 tears a document down through the task that loaded it.
			void document.loadingTask.destroy();
		}
	};
}

function imageSource(files: File[]): PageSource {
	return {
		count: files.length,
		async render(n) {
			const bitmap = await createImageBitmap(files[n - 1]);
			const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
			const canvas = canvasOf(bitmap.width * scale, bitmap.height * scale);
			const context = canvas.getContext('2d');
			if (!context) throw new Error('This browser cannot draw the page.');
			context.fillStyle = '#fff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			bitmap.close();
			return toJpeg(canvas);
		},
		close() {}
	};
}

/**
 * One PDF, or one or more images in the order picked. A PDF among several
 * files is refused: which pages of which file would be page 3 is a question
 * the form should not have to answer.
 */
export async function openPages(files: File[]): Promise<PageSource> {
	if (files.length === 0) throw new Error('Choose a PDF or the page images first.');
	const pdfs = files.filter(isPdf);
	if (pdfs.length > 0) {
		if (files.length > 1) throw new Error('Choose one PDF, or images only.');
		try {
			return await pdfSource(pdfs[0]);
		} catch (cause) {
			throw new Error(
				cause instanceof Error && /password/i.test(cause.message)
					? 'That PDF is password-protected.'
					: 'Could not open that PDF.'
			);
		}
	}
	return imageSource(files);
}
