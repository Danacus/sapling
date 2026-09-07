/**
 * `asr-model` — the one-time dictation model download.
 *
 * `tts-model`'s twin, over `./model-download`'s bar. Not cancellable, for the
 * same reason: the download runs in the Rust host, which does not listen for an
 * abort, so cancelling stops the tray watching and nothing else. Serial,
 * because the host coalesces two concurrent installs onto one lock anyway and a
 * second queued task is a truer thing to show than a second bar.
 *
 * **Two passes, always.** There is no browser recognizer to download, so this
 * kind only ever runs against a Tauri host, and a native install crosses the
 * model twice — down and then unpacked, both against the archive's own size
 * (`crates/sapling-desktop/src/models.rs`). The voice asks `voiceInstallPasses()`
 * because it has two hosts to tell apart; this one does not, and a function that
 * could only ever return 2 would be a worse way of saying so than the constant.
 */

import { preloadDictationModel } from '$lib/asr';
import { installWithBar } from './model-download';
import type { TaskKindDef } from '../types';

/** Download, then unpack: see the module note. */
const INSTALL_PASSES = 2;

export const asrModelTask = {
	serial: true,
	cancellable: false,

	title() {
		return 'Dictation model download';
	},

	async run(_input: undefined, ctx) {
		await installWithBar(ctx, INSTALL_PASSES, preloadDictationModel);
	},

	summary() {
		return 'Dictation model ready';
	}
} satisfies TaskKindDef<undefined, void>;
