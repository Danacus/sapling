/**
 * What the language picker shows and how it searches, from the runtime's CLDR
 * (`Intl.DisplayNames`) over `LANGUAGE_CODES` — no name table of our own. Pure,
 * so node runs it.
 */
import { foldDiacritics } from './fold';
import { LANGUAGE_CODES } from './language-codes';

export interface LanguageOption {
	/** Canonical BCP-47, what the profile stores. */
	tag: string;
	/** CLDR English name, what the profile's name field and every prompt read. */
	name: string;
	/** The language's name for itself, when it differs from `name`. */
	endonym?: string;
	/** Regional-indicator emoji, only for a tag with a two-letter region. */
	flag?: string;
}

/** `pt-br` → `pt-BR`; `undefined` for anything that is not a well-formed tag. */
export function canonicalTag(tag: string | undefined): string | undefined {
	const trimmed = tag?.trim();
	if (!trimmed) return undefined;
	try {
		return Intl.getCanonicalLocales(trimmed)[0];
	} catch {
		return undefined;
	}
}

let english: Intl.DisplayNames | undefined;

/** CLDR's English name for a tag, or `undefined` where it has none. */
export function englishName(tag: string): string | undefined {
	english ??= new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
	try {
		return english.of(tag);
	} catch {
		return undefined;
	}
}

function endonymOf(tag: string): string | undefined {
	try {
		return new Intl.DisplayNames([tag], { type: 'language', fallback: 'none' }).of(tag);
	} catch {
		return undefined;
	}
}

export function flagOf(tag: string): string | undefined {
	let region: string | undefined;
	try {
		region = new Intl.Locale(tag).region;
	} catch {
		return undefined;
	}
	// `es-419` is a numeric UN region: no flag exists for it.
	if (!region || !/^[A-Z]{2}$/.test(region)) return undefined;
	return String.fromCodePoint(...[...region].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** The option for a tag, or `undefined` when the runtime cannot name it. */
export function languageOption(tag: string | undefined): LanguageOption | undefined {
	const canonical = canonicalTag(tag);
	if (!canonical) return undefined;
	const name = englishName(canonical);
	if (!name || name.toLowerCase() === canonical.toLowerCase()) return undefined;
	const endonym = endonymOf(canonical);
	return {
		tag: canonical,
		name,
		endonym:
			endonym && endonym.toLocaleLowerCase() !== name.toLocaleLowerCase() ? endonym : undefined,
		flag: flagOf(canonical)
	};
}

let all: readonly LanguageOption[] | undefined;

/** Every offered language, a variant sorted straight after its base language. */
export function languageOptions(): readonly LanguageOption[] {
	all ??= LANGUAGE_CODES.map(languageOption)
		.filter((option): option is LanguageOption => option !== undefined)
		.map((option) => {
			const base = option.tag.split('-')[0];
			return { option, family: englishName(base) ?? option.name, variant: option.tag !== base };
		})
		.sort(
			(a, b) =>
				a.family.localeCompare(b.family) ||
				Number(a.variant) - Number(b.variant) ||
				a.option.name.localeCompare(b.option.name)
		)
		.map(({ option }) => option);
	return all;
}

/** Lowercase, accents dropped: "Español" and "espanol" search alike. */
export function searchKey(text: string): string {
	return foldDiacritics(text.toLowerCase()).trim();
}

/** Exact beats prefix beats word-start beats substring beats a loose subsequence. */
function scoreField(field: string | undefined, query: string): number {
	if (!field) return 0;
	const text = searchKey(field);
	if (text === query) return 100;
	if (text.startsWith(query)) return 80;
	const at = text.indexOf(query);
	if (at > 0) return /[\s(-]/.test(text[at - 1]) ? 60 : 40;

	let matched = 0;
	let gaps = 0;
	let last = -1;
	for (let i = 0; i < text.length && matched < query.length; i++) {
		if (text[i] !== query[matched]) continue;
		if (last >= 0) gaps += i - last - 1;
		last = i;
		matched += 1;
	}
	return matched === query.length ? Math.max(1, 20 - gaps) : 0;
}

/** How well `query` matches an option over its name, endonym and code; 0 is no match. */
export function scoreLanguage(option: LanguageOption, query: string): number {
	const key = searchKey(query);
	if (!key) return 1;
	return Math.max(
		scoreField(option.name, key),
		scoreField(option.endonym, key),
		scoreField(option.tag, key)
	);
}

/** The options matching `query`, best first; ties keep list order. */
export function searchLanguages(
	query: string,
	options: readonly LanguageOption[] = languageOptions()
): LanguageOption[] {
	if (!searchKey(query)) return [...options];
	return options
		.map((option, index) => ({ option, index, score: scoreLanguage(option, query) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ option }) => option);
}
