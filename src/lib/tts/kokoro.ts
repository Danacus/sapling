/**
 * The Kokoro-82M backend.
 *
 * `kokoro-js` pulls in Transformers.js and an ONNX runtime — hundreds of
 * kilobytes of JS before a byte of model is fetched — so it is **only ever
 * reached through a dynamic `import()`** inside {@link loadKokoro}. Nothing
 * here may import it statically, or it lands in the app's entry chunk and
 * every learner pays for a feature most of them will never switch on.
 *
 * Model weights are *not* cached by us: Transformers.js already stores every
 * downloaded file in the browser's Cache Storage under `transformers-cache`
 * (`env.useBrowserCache` defaults to true in the browser), so the ~90 MB
 * download happens once per browser profile. What we cache is the synthesized
 * audio, one layer up in `tts.ts`.
 */

import type { KokoroVoiceId } from './languages';
import { KOKORO_MODEL_ID } from './languages';
import { getTtsDevice, type TtsDevice } from './prefs';

/** One model file's download progress, as reported by Transformers.js. */
export interface TtsProgress {
	/** File being fetched, e.g. `onnx/model_quantized.onnx`. */
	file: string;
	/** 0-100. */
	progress: number;
	loaded: number;
	total: number;
}

type KokoroTTS = InstanceType<typeof import('kokoro-js').KokoroTTS>;

let instance: Promise<KokoroTTS> | null = null;
/** The device pref the live instance was built for; a change rebuilds it. */
let instanceDevice: TtsDevice | null = null;

const progressListeners = new Set<(progress: TtsProgress) => void>();

/** Whether the browser exposes WebGPU at all. */
export function webgpuAvailable(): boolean {
	return typeof navigator !== 'undefined' && Boolean((navigator as { gpu?: unknown }).gpu);
}

/**
 * Subscribe to model-download progress. Returns an unsubscribe function.
 * Progress only flows while a load is actually in flight; a warm model
 * reports nothing, which is why the settings button also handles the
 * "finished instantly" case.
 */
export function onKokoroProgress(listener: (progress: TtsProgress) => void): () => void {
	progressListeners.add(listener);
	return () => progressListeners.delete(listener);
}

/**
 * Drops the loaded model. Called when the device preference changes — there
 * is no way to re-target an ONNX session, so the next `speak()` rebuilds it.
 */
export function resetKokoro(): void {
	instance = null;
	instanceDevice = null;
}

/**
 * The shared `KokoroTTS` instance, loading it on first use.
 *
 * dtype is deliberately tied to the device: `q8` keeps the WASM download and
 * CPU cost sane, while WebGPU runs **fp32**. fp16 on WebGPU is a known source
 * of garbled Kokoro output on some GPU/driver combinations, so we never ask
 * for it — the extra download only happens for people who opted into WebGPU.
 */
export function loadKokoro(): Promise<KokoroTTS> {
	const devicePref = getTtsDevice();
	if (instance && instanceDevice !== devicePref) resetKokoro();
	if (instance) return instance;

	const device = devicePref === 'auto' && webgpuAvailable() ? 'webgpu' : 'wasm';
	instanceDevice = devicePref;

	const loading = (async () => {
		const { KokoroTTS } = await import('kokoro-js');
		return await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
			dtype: device === 'webgpu' ? 'fp32' : 'q8',
			device,
			progress_callback: (info) => {
				if (info.status !== 'progress') return;
				for (const listener of progressListeners) {
					listener({
						file: info.file,
						progress: info.progress,
						loaded: info.loaded,
						total: info.total
					});
				}
			}
		});
	})();

	instance = loading;
	// A failed load must not be remembered forever: clear the singleton so a
	// later attempt (better connection, different device pref) can retry.
	loading.catch(() => {
		if (instance === loading) resetKokoro();
	});

	return loading;
}

/** Synthesizes one phrase to a WAV blob. Rejects if the model cannot load. */
export async function synthesize(text: string, voice: KokoroVoiceId): Promise<Blob> {
	const tts = await loadKokoro();
	const audio = await tts.generate(text, { voice });
	return audio.toBlob();
}
