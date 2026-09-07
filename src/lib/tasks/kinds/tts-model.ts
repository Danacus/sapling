/**
 * `tts-model` — the one-time voice model download.
 *
 * Wraps `preloadKokoro`, whose per-file progress events are folded into one bar
 * by `./model-download`, which is also what `asr-model` uses and where the
 * arithmetic is explained. Not cancellable: the download runs in the TTS worker
 * (or, on a Tauri host, in the Rust host), neither of which listens for an
 * abort, so cancelling only stops the tray waiting on it. Serial, though both
 * providers already coalesce concurrent starts onto one promise.
 */

import { preloadKokoro, voiceInstallPasses } from '$lib/tts';
import { installWithBar } from './model-download';
import type { TaskKindDef } from '../types';

export const ttsModelTask = {
	serial: true,
	cancellable: false,

	title() {
		return 'Voice model download';
	},

	async run(_input: undefined, ctx) {
		await installWithBar(ctx, voiceInstallPasses(), preloadKokoro);
	},

	summary() {
		return 'Voice model ready';
	}
} satisfies TaskKindDef<undefined, void>;
