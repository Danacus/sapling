/**
 * The Web Speech API backend for dictation — `speak`'s mirror image, and today
 * the only engine behind {@link listen}.
 *
 * It differs from its synthesis counterpart in one way that shapes the UI:
 * **speech recognition is not universal.** `speechSynthesis` exists in every
 * browser the app runs in, so `$lib/tts` can always fall back to it; recognition
 * is Chrome/Edge/Safari and `webkitSpeechRecognition`-prefixed on most of them,
 * with no equivalent in Firefox. So the bottom of this ladder is not another
 * engine, it is *typing* — callers must feature-detect and simply not offer the
 * control, never degrade to a button that does nothing.
 *
 * It is also not local: Chrome ships the audio to a Google service. That is the
 * deliberate trade for step one — zero download, every language the learner
 * might pick — and the reason a local sherpa-onnx backend belongs beside this
 * one rather than replacing the seam.
 *
 * The DOM lib does not declare these types, so the structural shapes below are
 * the contract. They are deliberately minimal: only what is actually touched.
 */

/** One hypothesis for a stretch of speech. */
interface AlternativeLike {
	readonly transcript: string;
}

/** One stretch of speech, `isFinal` once the engine stops revising it. */
interface ResultLike {
	readonly length: number;
	readonly isFinal: boolean;
	readonly [index: number]: AlternativeLike | undefined;
}

/** The cumulative results for the session so far. */
export interface ResultListLike {
	readonly length: number;
	readonly [index: number]: ResultLike | undefined;
}

/** The bits of `SpeechRecognition` this module drives. */
interface RecognitionLike {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	start(): void;
	stop(): void;
	abort(): void;
	onresult: ((event: { results: ResultListLike }) => void) | null;
	onerror: ((event: { error: string }) => void) | null;
	onend: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

/** What the caller gets told while the microphone is open. */
export interface DictationHandlers {
	/**
	 * The transcript so far. Called repeatedly as the engine revises its guess,
	 * each call superseding the last, with `final` true on the one that sticks.
	 */
	onTranscript(text: string, final: boolean): void;
	/**
	 * The session is over. `message` is set only when the learner needs telling
	 * (a blocked microphone); an ordinary stop — including saying nothing at
	 * all — ends silently.
	 */
	onEnd(message?: string): void;
}

/** Handle on an open microphone. */
export interface DictationSession {
	/** Stop listening and keep what was heard. */
	stop(): void;
	/** Stop listening and drop it. */
	abort(): void;
}

/** The constructor under either name, or `undefined` where there is none. */
function recognitionCtor(): RecognitionCtor | undefined {
	const scope = globalThis as {
		SpeechRecognition?: RecognitionCtor;
		webkitSpeechRecognition?: RecognitionCtor;
	};
	return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Whether this browser can listen at all. */
export function webSpeechRecognitionAvailable(): boolean {
	return recognitionCtor() !== undefined;
}

/**
 * Flattens a results list into the one transcript to show.
 *
 * The list is cumulative over the session, so the whole utterance is the top
 * alternative of every result concatenated in order — and it is only `final`
 * once no result is still being revised.
 *
 * Concatenation is raw on purpose: Chrome puts the separating space *inside* the
 * continuation transcript for spaced languages and omits it entirely for Chinese,
 * which is the right answer in both cases and not one worth second-guessing here.
 *
 * Structurally typed so it can be unit-tested without a browser.
 */
export function bestTranscript(results: ResultListLike): { text: string; final: boolean } {
	let text = '';
	let final = results.length > 0;

	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		if (!result) continue;
		text += result[0]?.transcript ?? '';
		if (!result.isFinal) final = false;
	}

	return { text: text.trim(), final };
}

/**
 * What to tell the learner about an error code, or `undefined` to say nothing.
 *
 * Most of these are not failures. `no-speech` means they opened the mic and
 * thought better of it, and `aborted` is our own `abort()` coming back — the
 * same distinction `speakWithWebSpeech` draws for `interrupted`/`canceled`.
 * Only a microphone they could still fix is worth a line of UI.
 */
export function micErrorMessage(code: string): string | undefined {
	switch (code) {
		case 'not-allowed':
		case 'service-not-allowed':
			return 'Microphone access is blocked. Allow it in your browser settings to dictate.';
		case 'audio-capture':
			return 'No microphone found.';
		case 'network':
			return 'Dictation could not reach the speech service.';
		default:
			return undefined;
	}
}

/**
 * Opens the microphone for one utterance in `tag`.
 *
 * Returns `undefined` when the session never started — an unsupported browser,
 * or a constructor that threw — and in that case no handler ever fires, so a
 * caller can treat `undefined` as the whole of the failure. Once a session *is*
 * returned, `onEnd` is guaranteed exactly once.
 */
export function dictateWithWebSpeech(
	tag: string,
	handlers: DictationHandlers
): DictationSession | undefined {
	const Recognition = recognitionCtor();
	if (!Recognition) return undefined;

	let recognition: RecognitionLike;
	try {
		recognition = new Recognition();
	} catch (cause) {
		console.warn('[asr] Could not create a recognizer.', cause);
		return undefined;
	}

	recognition.lang = tag;
	// One utterance, then stop: a conversation turn is a sentence or two, and
	// continuous mode leaves the mic open through the learner's thinking.
	recognition.continuous = false;
	recognition.interimResults = true;
	recognition.maxAlternatives = 1;

	let message: string | undefined;
	let ended = false;

	recognition.onresult = (event) => {
		const { text, final } = bestTranscript(event.results);
		handlers.onTranscript(text, final);
	};

	recognition.onerror = (event) => {
		message = micErrorMessage(event.error);
		if (message) console.warn('[asr] Speech recognition failed.', event.error);
	};

	recognition.onend = () => {
		if (ended) return;
		ended = true;
		handlers.onEnd(message);
	};

	try {
		recognition.start();
	} catch (cause) {
		// Chrome throws here if a recognizer is already running.
		console.warn('[asr] Could not start listening.', cause);
		return undefined;
	}

	const guard = (act: () => void) => (): void => {
		try {
			act();
		} catch (cause) {
			console.warn('[asr] Could not stop listening.', cause);
		}
	};

	return {
		stop: guard(() => recognition.stop()),
		abort: guard(() => recognition.abort())
	};
}
