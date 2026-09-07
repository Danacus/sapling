/**
 * Speech-to-text for the app — one entry point, {@link listen}, and the same
 * hard rule as `$lib/tts` turned around: **the microphone never blocks the
 * conversation.** Every failure path here degrades to typing, because typing is
 * what the composer already does.
 *
 * The shape deliberately mirrors `tts.ts`, and for the same reason: there are
 * two backends now, picked per call.
 *
 * - **The host's recognizer** (`native.ts`) — sherpa-onnx running SenseVoice
 *   natively in the Tauri shell, on the device, for the languages that model
 *   covers. It is the only engine either of those webviews has: WebKitGTK
 *   exposes no `SpeechRecognition` constructor at all, and Android's WebView
 *   does not either.
 * - **Web Speech** (`webspeech.ts`) for everything else — every other language,
 *   and every browser that has it. Cloud-backed in Chrome and absent in
 *   Firefox, which is why it is a floor and not a destination.
 *
 * ## Which one, and how the question is asked
 *
 * The same shape `tts.ts` settled on: **ask the host, not the platform.**
 * `inTauri()` says only that there might be a host to ask; one memoised
 * `asr_status` probe says whether this build has a recognizer, whether its
 * model is downloaded, and — the part that decides routing — which languages it
 * covers. A shell built without the feature rejects that `invoke` like any
 * unknown command, and the answer is Web Speech or nothing, which is the path
 * this module has always had.
 *
 * The languages come *from the host* rather than being listed here, so swapping
 * the model is a `ModelSpec` change in the crate and nothing on this side.
 *
 * ## The transcript lands in the composer
 *
 * Unchanged, and it is what makes any of this safe: `appendDictation` splices
 * into the page's `input` and the learner presses Send, so a misheard word is a
 * typo they fix rather than a mistake the teacher corrects them for. No path
 * may send a transcript unread — and that matters more with a local model, not
 * less, because SenseVoice answers even when nobody spoke.
 *
 * Recognition is not universal, so {@link dictationAvailable} is a real
 * question with a real `false`: ask it before rendering a microphone control at
 * all. It is asynchronous now because the host has to be asked; it is also what
 * *warms* the probe, so {@link listen} can stay synchronous, which is the
 * contract the callers are written against.
 */

import { inTauri } from '$lib/platform';
import { bcp47For } from '$lib/tts/languages';

import { dictateWithWebSpeech, webSpeechRecognitionAvailable } from './webspeech';
import type { DictationHandlers, DictationSession } from './webspeech';
import type { AsrProgress, NativeAsrStatus } from './native';

export { appendDictation } from './compose';
export { bestTranscript, micErrorMessage } from './webspeech';
export type { DictationHandlers, DictationSession } from './webspeech';
export type { AsrProgress } from './native';

/** The host's recognizer, once the probe has landed. */
interface NativeDictation {
	status: NativeAsrStatus;
	dictate: (handlers: DictationHandlers) => DictationSession | undefined;
	install: () => Promise<void>;
	onProgress: (listener: (progress: AsrProgress) => void) => () => void;
}

/**
 * The settled probe, kept beside its promise as a plain value so {@link listen}
 * can read it without awaiting — which is the whole reason
 * {@link dictationAvailable} is the asynchronous one. `undefined` means either
 * "not asked yet" or "this host has none", and both route to Web Speech.
 */
let host: NativeDictation | undefined;
let probe: Promise<NativeDictation | undefined> | undefined;

/**
 * What the host says about dictation, asked once.
 *
 * The import is a statement of its own, and the call another, on purpose. Vite
 * wraps a dynamic import in its preload helper, and a `.then(...)` chained
 * straight onto the `import()` expression is wrapped *with* it — so a rejection
 * from inside that `.then` is reported as `vite:preloadError`, a chunk that
 * failed to load, and the layout's heal-by-reload fires for a host that merely
 * has no `asr_status`. That cost one reload per first visit to Settings on
 * Android when `tts.ts` had the same shape. Awaiting the module first keeps the
 * helper around the import alone.
 */
function hostDictation(): Promise<NativeDictation | undefined> {
	probe ??= (async () => {
		if (!inTauri()) return undefined;
		try {
			const module = await import('./native');
			const status = await module.nativeAsrStatus();
			host = {
				status,
				dictate: module.dictateNatively,
				install: module.installAsrModel,
				onProgress: module.onAsrProgress
			};
			return host;
		} catch (cause) {
			console.warn('[asr] This host has no recognizer of its own.', cause);
			return undefined;
		}
	})();
	return probe;
}

/**
 * Whether the host's model covers this language at all, downloaded or not.
 *
 * The comparison is on the BCP-47 **primary subtag**, so `zh-CN` and `zh-Hans`
 * both match `zh` while `yue` stays its own language, which is the line
 * `languages.ts` already draws for the voice.
 */
function covers(dictation: NativeDictation | undefined, language: string | undefined): boolean {
	if (!dictation) return false;
	const [primary] = bcp47For(language).toLowerCase().split('-');
	return dictation.status.languages.includes(primary);
}

/** …and whether it could actually transcribe it right now. */
function ready(dictation: NativeDictation | undefined, language: string | undefined): boolean {
	return covers(dictation, language) && dictation?.status.installed === true;
}

/**
 * Whether dictation would work at all for `language`. `false` means: offer no
 * button.
 *
 * Asynchronous because the answer is the host's, and it is the call that warms
 * the probe {@link listen} then reads synchronously — so a caller that renders
 * the microphone on the strength of this has already made `listen` able to
 * route.
 */
export async function dictationAvailable(language?: string): Promise<boolean> {
	if (ready(await hostDictation(), language)) return true;
	return webSpeechRecognitionAvailable();
}

/**
 * Whether the host's *own* model covers this language — asked by Settings,
 * which needs to say "your language is not one of these" before the download
 * rather than only after it. Independent of whether the model is on disk;
 * {@link dictationAvailable} is the question about right now.
 */
export async function dictationCoversLanguage(language?: string): Promise<boolean> {
	return covers(await hostDictation(), language);
}

/**
 * Opens the microphone for one utterance in the learner's target language.
 *
 * Returns `undefined` when the session never started, in which case no handler
 * fires; otherwise `onEnd` runs exactly once, whether the learner stopped it,
 * the engine did, or something failed.
 *
 * Synchronous, deliberately, because that is the contract the pages are written
 * against — and it is why {@link dictationAvailable} exists as the awaited
 * half. A caller that never awaited it simply gets Web Speech, which is the
 * right answer everywhere the host has nothing to offer anyway.
 */
export function listen(
	language: string | undefined,
	handlers: DictationHandlers
): DictationSession | undefined {
	if (ready(host, language)) return host?.dictate(handlers);
	return dictateWithWebSpeech(bcp47For(language), handlers);
}

/**
 * Bytes a first install of the recognition model downloads, or 0 where there is
 * nothing to install — every browser, and a host with no recognizer.
 *
 * Never rejects: Settings fires this off without waiting for it, so a rejection
 * here would be an unhandled one. Same contract as `voiceDownloadBytes`.
 */
export async function dictationDownloadBytes(): Promise<number> {
	return (await hostDictation())?.status.downloadBytes ?? 0;
}

/** Whether the recognition model is already on this device. */
export async function dictationModelInstalled(): Promise<boolean> {
	return (await hostDictation())?.status.installed ?? false;
}

/**
 * Downloads the recognition model (the Settings button, through the
 * `asr-model` task). Resolves when it is ready; rejects only so the caller can
 * show an error.
 *
 * The probe's `installed` is updated on success rather than re-fetched: the
 * install returning *is* the fact, and without it the microphone button would
 * stay hidden until the next time the page mounted.
 */
export async function preloadDictationModel(
	onProgress?: (progress: AsrProgress) => void
): Promise<void> {
	const dictation = await hostDictation();
	if (!dictation) throw new Error('this host has no recognizer of its own');

	const unsubscribe = onProgress ? dictation.onProgress(onProgress) : undefined;
	try {
		await dictation.install();
		dictation.status.installed = true;
	} finally {
		unsubscribe?.();
	}
}
