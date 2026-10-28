/**
 * The Web Speech API backend — the fallback, and the *only* engine for every
 * language Kokoro does not cover (see the note in `languages.ts`: that is
 * every language without a registered sherpa model).
 *
 * Quality depends entirely on the voices the learner's OS ships, which is
 * exactly why it beats Kokoro there: a Dutch machine has a real Dutch voice,
 * whereas Kokoro would read Dutch through an English phonemizer.
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
 * Within each, Apple's many voices per language are ranked by quality, so
 * a novelty voice like Albert is only ever the last resort.
 *
 * Structurally typed so it can be unit-tested without a DOM.
 */
export function pickVoice<
	T extends { lang: string; name?: string; voiceURI?: string; default?: boolean }
>(voices: readonly T[], tag: string): T | undefined {
	const wanted = tag.toLowerCase().replace(/_/g, '-');
	const base = wanted.split('-')[0];

	const normalized = voices.map((voice) => ({
		voice,
		lang: voice.lang.toLowerCase().replace(/_/g, '-')
	}));

	const best = (matches: typeof normalized): T | undefined =>
		matches
			.map(({ voice }) => ({ voice, rank: voiceRank(voice) }))
			.sort((a, b) => b.rank - a.rank)[0]?.voice;

	return (
		best(normalized.filter((entry) => entry.lang === wanted)) ??
		best(normalized.filter((entry) => entry.lang.split('-')[0] === base))
	);
}

/** Higher is better; Apple encodes the tier in `voiceURI` (or a name suffix). */
function voiceRank(voice: { name?: string; voiceURI?: string; default?: boolean }): number {
	const uri = (voice.voiceURI ?? '').toLowerCase();
	const name = (voice.name ?? '').toLowerCase();
	const tieBreak = voice.default ? 0.5 : 0;
	if (uri.startsWith('com.apple.speech.synthesis.voice.')) return 0 + tieBreak;
	if (uri.startsWith('com.apple.eloquence.')) return 1 + tieBreak;
	if (uri.includes('.premium.') || name.includes('(premium)')) return 5 + tieBreak;
	if (uri.includes('.enhanced.') || name.includes('(enhanced)')) return 4 + tieBreak;
	if (uri.includes('.compact.')) return 2 + tieBreak;
	return 3 + tieBreak;
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
