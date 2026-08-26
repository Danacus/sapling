/**
 * Language-name → speech-engine mapping.
 *
 * The profile stores `targetLanguage` as free text ("Spanish", "Mandarin
 * Chinese", occasionally just "nl"), so everything downstream has to guess a
 * language tag from a human-written string. That guess is pure and lives here
 * so it can be unit-tested without a browser.
 *
 * ## What Kokoro covers here: Mandarin and English
 *
 * The neural engine is Kokoro **v1.1-zh** running under sherpa-onnx, which
 * carries the Chinese frontend the model needs (a lexicon plus a phrase
 * matcher for word segmentation) alongside espeak-ng for English. That is the
 * model's honest coverage: 3 English voices, 100 Mandarin voices, and mixed
 * zh/en sentences handled per-run. It was trained on nothing else.
 *
 * So Mandarin and English route to Kokoro; every other language routes to the
 * Web Speech API, which at least uses a voice actually trained for it. Reading
 * Dutch or Japanese with a Mandarin/English frontend would produce confident
 * nonsense — the worst possible outcome for a pronunciation aid.
 *
 * Cantonese (`yue`) and Traditional Chinese (`zh-TW`) deliberately do *not*
 * count as covered: the model is Mandarin, and `zh-TW` text is Traditional
 * script the lexicon does not contain.
 */

import { getTtsVoice, type TtsVoice } from './prefs';

export { KOKORO_MODEL_ID } from './models';

/** Used whenever a language name means nothing to us. */
export const DEFAULT_LANGUAGE_TAG = 'en';

/**
 * A speaker in the model's `voices.bin`.
 *
 * The ids are positional, fixed by k2-fsa's `generate_voices_bin.py`: three
 * English voices first (`af_maple`, `af_sol`, `bf_vale`), then the Chinese
 * `zf_*` voices in numeric order, then the `zm_*` ones — 103 in total, which
 * matches `voices.bin` exactly (103 x 510 x 256 x 4 B = 53,790,720 B).
 */
export interface KokoroSpeaker {
	/** Name as used upstream, e.g. `zf_001`. */
	readonly name: string;
	/** Index passed to sherpa-onnx as `sid`. */
	readonly id: number;
	/** What Settings shows. */
	readonly label: string;
}

/** American English female — the default English voice. */
const AF_MAPLE: KokoroSpeaker = { name: 'af_maple', id: 0, label: 'English — Maple (American)' };
/** British English female, used when the tag says so. */
const BF_VALE: KokoroSpeaker = { name: 'bf_vale', id: 2, label: 'English — Vale (British)' };

/**
 * The Mandarin voices offered in Settings. Three out of a hundred, chosen to
 * span the useful range (two female, one male) rather than to be exhaustive —
 * a 100-entry dropdown would be worse than no choice at all.
 *
 * Honesty note: these were picked from the upstream speaker table, not by
 * listening to them. `zf_001` is the default because it is the reference voice
 * k2-fsa itself uses when exporting the model.
 */
export const MANDARIN_SPEAKERS: readonly KokoroSpeaker[] = [
	{ name: 'zf_001', id: 3, label: 'Mandarin — female (zf_001)' },
	{ name: 'zf_018', id: 12, label: 'Mandarin — female (zf_018)' },
	{ name: 'zm_010', id: 59, label: 'Mandarin — male (zm_010)' }
];

/** The Mandarin voice used when the preference is `auto`. */
export const DEFAULT_MANDARIN_SPEAKER = MANDARIN_SPEAKERS[0];

/**
 * Language name → BCP-47 tag. Covers the onboarding datalist plus the aliases
 * people actually type; anything unknown falls back to
 * {@link DEFAULT_LANGUAGE_TAG}. Keys must be normalized (lowercase, single
 * spaces) — see {@link normalize}.
 */
const LANGUAGE_TAGS: Readonly<Record<string, string>> = {
	// Onboarding datalist ----------------------------------------------------
	english: 'en',
	spanish: 'es',
	french: 'fr',
	german: 'de',
	italian: 'it',
	portuguese: 'pt',
	dutch: 'nl',
	swedish: 'sv',
	norwegian: 'nb',
	danish: 'da',
	polish: 'pl',
	czech: 'cs',
	greek: 'el',
	turkish: 'tr',
	russian: 'ru',
	ukrainian: 'uk',
	arabic: 'ar',
	hebrew: 'he',
	hindi: 'hi',
	'mandarin chinese': 'zh-CN',
	japanese: 'ja',
	korean: 'ko',
	vietnamese: 'vi',
	indonesian: 'id',

	// Common variants and endonyms ------------------------------------------
	'american english': 'en-US',
	'british english': 'en-GB',
	castilian: 'es',
	espanol: 'es',
	español: 'es',
	francais: 'fr',
	français: 'fr',
	deutsch: 'de',
	italiano: 'it',
	'brazilian portuguese': 'pt-BR',
	portugues: 'pt',
	português: 'pt',
	nederlands: 'nl',
	flemish: 'nl-BE',
	'norwegian bokmal': 'nb',
	'norwegian bokmål': 'nb',
	finnish: 'fi',
	icelandic: 'is',
	slovak: 'sk',
	hungarian: 'hu',
	romanian: 'ro',
	bulgarian: 'bg',
	croatian: 'hr',
	serbian: 'sr',
	persian: 'fa',
	farsi: 'fa',
	urdu: 'ur',
	bengali: 'bn',
	tamil: 'ta',
	chinese: 'zh-CN',
	mandarin: 'zh-CN',
	putonghua: 'zh-CN',
	'普通话': 'zh-CN',
	'中文': 'zh-CN',
	'simplified chinese': 'zh-CN',
	'traditional chinese': 'zh-TW',
	cantonese: 'yue',
	thai: 'th',
	malay: 'ms',
	filipino: 'tl',
	tagalog: 'tl',
	swahili: 'sw',
	catalan: 'ca',
	irish: 'ga',
	welsh: 'cy'
};

/** Longest keys first, so "mandarin chinese" wins over "chinese". */
const LANGUAGE_KEYS_BY_LENGTH = Object.keys(LANGUAGE_TAGS).sort((a, b) => b.length - a.length);

/** A BCP-47-ish tag typed directly, e.g. `nl`, `pt-BR`, `zh-Hans`. */
const TAG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function normalize(language: string): string {
	return language
		.toLowerCase()
		.replace(/[(),./]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** `pt-br` → `pt-BR`, `EN` → `en`. Cosmetic, but `utterance.lang` prefers it. */
function canonicalizeTag(tag: string): string {
	const [base, ...rest] = tag.split('-');
	return [
		base.toLowerCase(),
		...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part.toLowerCase()))
	].join('-');
}

/**
 * Best-effort BCP-47 tag for a free-text language name.
 *
 * Tries, in order: an exact name match, a bare language tag the learner typed
 * themselves, then the longest known language name contained in the string
 * (so "Mandarin Chinese (Simplified)" still lands on `zh-CN`). Falls back to
 * {@link DEFAULT_LANGUAGE_TAG} — a wrong-but-valid tag just makes the browser
 * pick its default voice, which beats throwing mid-lesson.
 */
export function bcp47For(language: string | undefined): string {
	const name = normalize(language ?? '');
	if (!name) return DEFAULT_LANGUAGE_TAG;

	const exact = LANGUAGE_TAGS[name];
	if (exact) return exact;

	if (TAG_PATTERN.test(name) && !name.includes(' ')) return canonicalizeTag(name);

	for (const key of LANGUAGE_KEYS_BY_LENGTH) {
		// Word-boundary containment: "old english" must not match "english"'s
		// neighbours, but "mandarin chinese dialect" should still match.
		if (new RegExp(`(^|\\s)${key}(\\s|$)`).test(name)) return LANGUAGE_TAGS[key];
	}

	return DEFAULT_LANGUAGE_TAG;
}

/**
 * The Kokoro speaker to use for a language, or `undefined` when Kokoro cannot
 * honestly speak it (see the module note — everything but Mandarin and
 * English).
 *
 * `voice` is the learner's Settings choice. It only ever applies to Mandarin:
 * the curated options are all Mandarin speakers, and an English phrase asked
 * for in `zf_001` would come out as a Chinese speaker reading English, so
 * English always uses its own voice regardless of the preference.
 */
export function kokoroSpeakerFor(
	language: string | undefined,
	voice: TtsVoice = getTtsVoice()
): KokoroSpeaker | undefined {
	const [base, region] = bcp47For(language).toLowerCase().split('-');

	if (base === 'en') return region === 'gb' ? BF_VALE : AF_MAPLE;
	if (!isMandarin(language)) return undefined;

	return MANDARIN_SPEAKERS.find((speaker) => speaker.name === voice) ?? DEFAULT_MANDARIN_SPEAKER;
}

/**
 * Whether this language is Mandarin as far as the app is concerned — the one
 * question the voice picker, the speaker mapping and the mock fixtures all ask.
 *
 * `zh-TW` is Traditional script and `yue` is Cantonese; this model speaks
 * neither, so neither counts. Exported because a caller that re-derived the
 * rule had already drifted from it (it checked `zh-TW` but not `zh-Hant`).
 */
export function isMandarin(language: string | undefined): boolean {
	const [base, region] = bcp47For(language).toLowerCase().split('-');
	return base === 'zh' && region !== 'tw' && region !== 'hant';
}

/** Whether Kokoro covers this language at all. */
export function kokoroSupports(language: string | undefined): boolean {
	return kokoroSpeakerFor(language, 'auto') !== undefined;
}
