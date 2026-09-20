/**
 * `tts-model` — the one-time voice model download.
 *
 * Wraps `preloadVoice`, whose per-file progress events are folded into one bar
 * by `./model-download`, which is also what `asr-model` uses and where the
 * arithmetic is explained. Not cancellable: the download runs in the TTS worker
 * (or, on a Tauri host, in the Rust host), neither of which listens for an
 * abort, so cancelling only stops the tray waiting on it. Serial, though both
 * providers already coalesce concurrent starts onto one promise.
 */

import { preloadVoice, voiceInstallPasses } from '$lib/tts';
import { installWithBar } from './model-download';
import type { TaskKindDef } from '../types';

export const ttsModelTask = {
	serial: true,
	cancellable: false,

	title() {
		return 'Voice model download';
	},

	async run(language: string, ctx) {
		await installWithBar(ctx, voiceInstallPasses(), (onProgress) =>
			preloadVoice(language, onProgress)
		);
	},

	summary() {
		return 'Voice model ready';
	}
} satisfies TaskKindDef<string, void>;
