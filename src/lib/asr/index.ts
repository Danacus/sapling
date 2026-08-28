/**
 * Speech-to-text for the app — one entry point, {@link listen}, and the same
 * hard rule as `$lib/tts` turned around: **the microphone never blocks the
 * conversation.** Every failure path here degrades to typing, because typing is
 * what the composer already does.
 *
 * The shape deliberately mirrors `tts.ts`, so the second backend is a swap
 * rather than a refactor: languages resolve through the same `bcp47For`, and the
 * engine sits behind this façade. Today there is exactly one —
 *
 * - **Web Speech** (`webspeech.ts`) for every language, since it takes the same
 *   BCP-47 tag the voice picker does. It is cloud-backed in Chrome and absent in
 *   Firefox, so it is a starting point, not the destination.
 *
 * — and a local sherpa-onnx recognizer for Mandarin belongs beside it, chosen
 * per call the way `speak` chooses Kokoro, once dictation has earned it.
 *
 * Recognition is not universal, so {@link dictationAvailable} is a real question
 * with a real `false`: ask it before rendering a microphone control at all.
 */

import { bcp47For } from '$lib/tts/languages';

import { dictateWithWebSpeech, webSpeechRecognitionAvailable } from './webspeech';
import type { DictationHandlers, DictationSession } from './webspeech';

export { appendDictation } from './compose';
export { bestTranscript, micErrorMessage } from './webspeech';
export type { DictationHandlers, DictationSession } from './webspeech';

/** Whether this browser can dictate at all. `false` means: offer no button. */
export function dictationAvailable(): boolean {
	return webSpeechRecognitionAvailable();
}

/**
 * Opens the microphone for one utterance in the learner's target language.
 *
 * Returns `undefined` when the session never started, in which case no handler
 * fires; otherwise `onEnd` runs exactly once, whether the learner stopped it,
 * the engine did, or something failed.
 */
export function listen(
	language: string | undefined,
	handlers: DictationHandlers
): DictationSession | undefined {
	return dictateWithWebSpeech(bcp47For(language), handlers);
}
