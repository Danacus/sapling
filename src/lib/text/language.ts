/**
 * A free-text language name → a BCP-47 tag.
 *
 * The profile stores `targetLanguage` as free text ("Spanish", "Mandarin
 * Chinese", occasionally just "nl"), so everything downstream has to guess a
 * language tag from a human-written string: the voice routing (`$lib/tts`),
 * dictation (`$lib/asr`), which romanizer applies and whether a language is
 * written with readings (`$lib/romanize`). That guess is a fact about text, not
 * about any one of those, so it lives here — it sat in `$lib/tts` once, and the
 * romanizer and the recognizer importing a speech module for it tied three
 * areas together for one pure function.
 */

/** Used whenever a language name means nothing to us. */
export const DEFAULT_LANGUAGE_TAG = 'en';

/**
 * Language name → BCP-47 tag. Covers the onboarding datalist plus the aliases
 * people actually type; anything unknown falls back to
 * {@link DEFAULT_LANGUAGE_TAG}. Keys must be normalized (lowercase, single
 * spaces) — see {@link normalizeName}.
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
	普通话: 'zh-CN',
	中文: 'zh-CN',
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

function normalizeName(language: string): string {
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
	const name = normalizeName(language ?? '');
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
