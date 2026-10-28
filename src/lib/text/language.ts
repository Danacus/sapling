/**
 * Which language a profile means, as a BCP-47 tag — what voice, dictation and
 * the romanizer route on. The picker stores the tag beside the name; a profile
 * typed as free text before the picker, or saved since by an older build
 * (whose struct strips the tag), has only the name, which
 * {@link legacyLanguageTag} reads instead. Nothing here guesses English: an
 * unresolved language is no tag, and every consumer then does nothing
 * language-specific.
 */
import type { Profile } from '$lib/types';

import { canonicalTag, englishName, languageOptions, searchKey } from './language-options';

/**
 * Migration only: names learners typed before the picker existed. Anything a
 * CLDR name or endonym already covers is matched through `languageOptions`
 * instead. Keys are normalized (see {@link normalizeName}).
 */
const LEGACY_NAMES: Readonly<Record<string, string>> = {
	norwegian: 'nb',
	'mandarin chinese': 'zh-CN',
	chinese: 'zh-CN',
	mandarin: 'zh-CN',
	putonghua: 'zh-CN',
	普通话: 'zh-CN',
	中文: 'zh-CN',
	'simplified chinese': 'zh-CN',
	'traditional chinese': 'zh-TW',
	castilian: 'es',
	flemish: 'nl-BE',
	vlaams: 'nl-BE',
	'norwegian bokmal': 'nb',
	farsi: 'fa',
	bengali: 'bn',
	filipino: 'tl',
	tagalog: 'tl'
};

/** Longest keys first, so "mandarin chinese" wins over "chinese". */
const LEGACY_KEYS_BY_LENGTH = Object.keys(LEGACY_NAMES).sort((a, b) => b.length - a.length);

/** A tag typed directly, e.g. `nl`, `pt-BR`, `zh-Hans`. */
const TAG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function normalizeName(language: string): string {
	return searchKey(language.replace(/[(),./]/g, ' ').replace(/\s+/g, ' '));
}

/**
 * A free-text language name → a tag, or `undefined` when it names nothing we
 * know: a legacy alias, a tag typed as such, then any offered language's CLDR
 * name or endonym, then a known name inside a longer one.
 */
export function legacyLanguageTag(language: string | undefined): string | undefined {
	const name = normalizeName(language ?? '');
	if (!name) return undefined;

	const alias = LEGACY_NAMES[name];
	if (alias) return alias;

	if (TAG_PATTERN.test(name)) {
		const tag = canonicalTag(name);
		if (tag && englishName(tag)) return tag;
	}

	const named = languageOptions().find(
		(option) =>
			normalizeName(option.name) === name ||
			(option.endonym !== undefined && normalizeName(option.endonym) === name)
	);
	if (named) return named.tag;

	for (const key of LEGACY_KEYS_BY_LENGTH) {
		if (new RegExp(`(^|\\s)${key}(\\s|$)`).test(name)) return LEGACY_NAMES[key];
	}
	const contained = languageOptions().find((option) =>
		new RegExp(`(^|\\s)${normalizeName(option.name)}(\\s|$)`).test(name)
	);
	return contained?.tag;
}

/** The target language's tag: the stored one, else the name read once more. */
export function targetTagOf(
	profile: Pick<Profile, 'targetLanguage' | 'targetLanguageTag'> | undefined
): string | undefined {
	return canonicalTag(profile?.targetLanguageTag) ?? legacyLanguageTag(profile?.targetLanguage);
}

/** The native language's tag, resolved like {@link targetTagOf}. */
export function nativeTagOf(
	profile: Pick<Profile, 'nativeLanguage' | 'nativeLanguageTag'> | undefined
): string | undefined {
	return canonicalTag(profile?.nativeLanguageTag) ?? legacyLanguageTag(profile?.nativeLanguage);
}

/** `zh-Hant-TW` → `zh`; `undefined` for no tag. */
export function primarySubtag(tag: string | undefined): string | undefined {
	return tag ? tag.split('-')[0].toLowerCase() || undefined : undefined;
}
