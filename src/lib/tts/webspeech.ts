/**
 * The Web Speech API backend — the fallback, and the *only* engine for
 * non-English target languages (see the note in `languages.ts`).
 *
 * Quality depends entirely on the voices the learner's OS ships, which is
 * exactly why it beats Kokoro here: a Dutch machine has a real Dutch voice,
 * whereas Kokoro would read Dutch with American English phonemes.
 */

/** Whether this browser can speak at all. */
export function webSpeechAvailable(): boolean {
	return (
		typeof globalThis.speechSynthesis !== 'undefined' &&
		typeof globalThis.SpeechSynthesisUtterance === 'function'
	);
}

/**
 * Best voice for a BCP-47 tag: an exact tag match first (`pt-BR` over `pt`),
 * then any voice for the same base language, then nothing — in which case the
 * browser picks its own default, which is still better than silence.
 *
 * Structurally typed so it can be unit-tested without a DOM.
 */
export function pickVoice<T extends { lang: string }>(
	voices: readonly T[],
	tag: string
): T | undefined {
	const wanted = tag.toLowerCase().replace(/_/g, '-');
	const base = wanted.split('-')[0];

	const normalized = voices.map((voice) => ({
		voice,
		lang: voice.lang.toLowerCase().replace(/_/g, '-')
	}));

	return (
		normalized.find((entry) => entry.lang === wanted)?.voice ??
		normalized.find((entry) => entry.lang.split('-')[0] === base)?.voice
	);
}

/** Stops anything the browser is currently saying. Safe to call blind. */
export function cancelWebSpeech(): void {
	if (!webSpeechAvailable()) return;
	try {
		speechSynthesis.cancel();
	} catch {
		/* ignore: some browsers throw when nothing is queued */
	}
}

/**
 * Speaks `text` and resolves when the utterance finishes.
 *
 * Never rejects: an unsupported browser, a missing voice or a synthesis error
 * all resolve quietly (with a warning), because audio must not be able to
 * stall a lesson.
 */
export function speakWithWebSpeech(text: string, tag: string): Promise<void> {
	if (!webSpeechAvailable()) {
		console.warn('[tts] This browser has no speech synthesis; skipping playback.');
		return Promise.resolve();
	}

	return new Promise<void>((resolve) => {
		try {
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.lang = tag;

			const voice = pickVoice(speechSynthesis.getVoices(), tag);
			if (voice) utterance.voice = voice;

			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};

			utterance.onend = done;
			utterance.onerror = (event) => {
				// 'interrupted'/'canceled' are our own doing (a second tap); the rest
				// are worth a line in the console.
				if (event.error !== 'interrupted' && event.error !== 'canceled') {
					console.warn('[tts] Speech synthesis failed.', event.error);
				}
				done();
			};

			speechSynthesis.speak(utterance);
		} catch (cause) {
			console.warn('[tts] Speech synthesis failed.', cause);
			resolve();
		}
	});
}
