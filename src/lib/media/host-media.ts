/**
 * A local recording read by the Tauri desktop host (`sapling-media`, on the
 * system GStreamer): the picked file staged in chunks, then its length, its
 * audio as 16 kHz PCM and a grey crop of any frame. The webview cannot do
 * this itself — WebKitGTK's `decodeAudioData` holds a whole film in memory
 * and a seeked `<video>` drawn to a canvas reads back blank (`desktop.md`).
 *
 * Desktop only: on Android and in a browser `mediaAvailable()` is false.
 */
import { inTauri } from '$lib/platform';
import type { Raster } from '$lib/ocr';

export interface MediaInfo {
	durationMs: number;
	/** 0 for a recording with no picture. */
	width: number;
	height: number;
	audio: boolean;
}

/** Bytes per staging call: big enough to be few, small enough to stay responsive. */
const CHUNK_BYTES = 8 << 20;

let api: Promise<typeof import('@tauri-apps/api/core')> | undefined;
const core = () => (api ??= import('@tauri-apps/api/core'));

let available: Promise<boolean> | undefined;

/** Whether this host reads recordings at all. Memoised; never rejects. */
export function mediaAvailable(): Promise<boolean> {
	available ??= inTauri()
		? core()
				.then(({ invoke }) => invoke<boolean>('media_status'))
				.catch(() => false)
		: Promise.resolve(false);
	return available;
}

/** Copies `file` to the host under `id`, reporting bytes as they go. */
export async function stageMedia(
	id: string,
	file: Blob,
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal
): Promise<void> {
	const { invoke } = await core();
	for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
		signal?.throwIfAborted();
		const chunk = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
		await invoke('media_stage', chunk, {
			headers: { 'sapling-media': id, 'sapling-offset': String(offset) }
		});
		onProgress?.(Math.min(offset + CHUNK_BYTES, file.size), file.size);
	}
}

export async function probeMedia(id: string): Promise<MediaInfo> {
	const { invoke } = await core();
	return invoke<MediaInfo>('media_probe', { id });
}

/** 16 kHz mono 16-bit LE PCM from `fromMs` to `toMs`. */
export async function mediaAudio(id: string, fromMs: number, toMs: number): Promise<Uint8Array> {
	const { invoke } = await core();
	return new Uint8Array(await invoke<ArrayBuffer>('media_audio', { id, fromMs, toMs }));
}

/** The frame on screen at `atMs`, cropped to `rect`, as a grey RGBA raster. */
export async function mediaFrame(
	id: string,
	atMs: number,
	rect: { x: number; y: number; width: number; height: number }
): Promise<Raster> {
	const { invoke } = await core();
	const bytes = new Uint8Array(await invoke<ArrayBuffer>('media_frame', { id, atMs, ...rect }));
	const head = new DataView(bytes.buffer, bytes.byteOffset, 8);
	return {
		width: head.getUint32(0, true),
		height: head.getUint32(4, true),
		data: bytes.subarray(8)
	};
}

/** Removes the staged copy. Never rejects: it is cleanup. */
export async function releaseMedia(id: string): Promise<void> {
	try {
		const { invoke } = await core();
		await invoke('media_release', { id });
	} catch {
		// The host sweeps its staging directory at the next start anyway.
	}
}
