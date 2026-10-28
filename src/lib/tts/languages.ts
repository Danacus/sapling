/**
 * Language tag → speech-engine mapping.
 *
 * Every function takes the profile's BCP-47 tag (`$lib/text`'s `targetTagOf`),
 * `undefined` when the language is unresolved; what lives here is which engine
 * and speaker can honestly pronounce that tag. Pure, so it can be unit-tested
 * without a browser.
 *
 * ## What Kokoro covers here: Mandarin and English
 *
 * The neural engine is Kokoro **v1.1-zh** running under sherpa-onnx, which
 * carries the Chinese frontend the model needs (a lexicon plus a phrase
 * matcher for word segmentation) alongside espeak-ng for English. That is the
 * model's honest coverage: 3 English voices, 100 Mandarin voices, and mixed
 * zh/en sentences handled per-run. It was trained on nothing else.
 *
 * Mandarin and English route to Kokoro, while Cantonese routes to its VITS
 * model. Every other language uses Web Speech, which at least selects a voice
 * trained for it. Reading Dutch or Japanese with a Chinese frontend would
 * produce confident nonsense — the worst possible pronunciation aid.
 *
 * Cantonese (`yue`) and Traditional Chinese (`zh-TW`) do not count as covered
 * by Kokoro itself; the model registry makes Cantonese a separate choice.
 */

import { primarySubtag } from '$lib/text';

import { getTtsVoice, type TtsVoice } from './prefs';
import type { TtsModelId } from './models';

export { KOKORO_MODEL_ID } from './models';

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

/** One concrete model/speaker choice produced by language routing. */
export interface SherpaVoice extends KokoroSpeaker {
	readonly model: TtsModelId;
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
	tag: string | undefined,
	voice: TtsVoice = getTtsVoice()
): KokoroSpeaker | undefined {
	if (primarySubtag(tag) === 'en') return regionOf(tag) === 'GB' ? BF_VALE : AF_MAPLE;
	if (!isMandarin(tag)) return undefined;

	return MANDARIN_SPEAKERS.find((speaker) => speaker.name === voice) ?? DEFAULT_MANDARIN_SPEAKER;
}

/**
 * Whether this language is Mandarin as far as the app is concerned — the one
 * question the voice picker, the speaker mapping and the mock fixtures all ask.
 *
 * Chinese written in Simplified script once CLDR fills in the likely script:
 * `zh-TW`, `zh-HK` and `zh-Hant` are Traditional and `yue` is Cantonese, and
 * this model speaks none of them. Exported because a caller that re-derived
 * the rule had already drifted from it.
 */
export function isMandarin(tag: string | undefined): boolean {
	const locale = localeOf(tag)?.maximize();
	return locale?.language === 'zh' && locale.script === 'Hans';
}

function localeOf(tag: string | undefined): Intl.Locale | undefined {
	if (!tag) return undefined;
	try {
		return new Intl.Locale(tag);
	} catch {
		return undefined;
	}
}

function regionOf(tag: string | undefined): string | undefined {
	return localeOf(tag)?.region;
}

/** Whether Kokoro covers this language at all. */
export function kokoroSupports(tag: string | undefined): boolean {
	return kokoroSpeakerFor(tag, 'auto') !== undefined;
}

/** The sherpa model and speaker that can honestly pronounce this language. */
export function sherpaVoiceFor(
	tag: string | undefined,
	voice: TtsVoice = getTtsVoice()
): SherpaVoice | undefined {
	if (primarySubtag(tag) === 'yue') {
		return { model: 'cantonese', name: 'cantonese-xiaomaiiwn', id: 0, label: 'Cantonese' };
	}
	const speaker = kokoroSpeakerFor(tag, voice);
	return speaker ? { model: 'kokoro', ...speaker } : undefined;
}

/** Whether one of the installed-on-demand sherpa models covers this language. */
export function sherpaSupports(tag: string | undefined): boolean {
	return sherpaVoiceFor(tag, 'auto') !== undefined;
}
