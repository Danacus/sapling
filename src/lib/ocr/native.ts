/**
 * OCR on a Tauri host: `ocr_page` runs the same pipeline in Rust
 * (`crates/sapling-ocr`) on native ONNX Runtime with every core. The raster
 * crosses as the raw body, its size and the model set as headers.
 */
import type { OcrProgress, OcrResult } from './index';
import type { ModelSet } from './models';
import type { Raster } from './pipeline';

const PROGRESS_EVENT = 'ocr://progress';

export async function ocrPageNatively(
	raster: Raster,
	set: ModelSet,
	onProgress?: (progress: OcrProgress) => void
): Promise<OcrResult> {
	const [{ invoke }, { listen }] = await Promise.all([
		import('@tauri-apps/api/core'),
		import('@tauri-apps/api/event')
	]);
	const unlisten = onProgress
		? await listen<OcrProgress>(PROGRESS_EVENT, ({ payload }) => onProgress(payload))
		: undefined;
	try {
		const body = new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
		return await invoke<OcrResult>('ocr_page', body, {
			headers: {
				'sapling-width': String(raster.width),
				'sapling-height': String(raster.height),
				'sapling-ocr-set': set.id
			}
		});
	} finally {
		unlisten?.();
	}
}
