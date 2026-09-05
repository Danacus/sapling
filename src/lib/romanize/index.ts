/**
 * Local romanizers, by language — the registry, and the fallback signal.
 *
 * Target-language text in this app has always carried a `reading`: a Latin
 * romanization the LLM wrote alongside the sentence. That works, but it is one
 * flat string for a whole sentence, it costs tokens, it is occasionally wrong,
 * and it can leak the answer. Where we can compute the reading *locally* we
 * would rather do that: per token instead of per sentence (so the UI can draw
 * ruby text and hide the words the learner already knows, one at a time), always
 * correct for the script, free, and retroactive — an old pooled challenge
 * generated before any of this gets annotated just the same, because nothing
 * here reads the stored field.
 *
 * Not every language has a local implementation, and this module answering
 * `null` **is** the fallback signal: no romanizer means the caller keeps
 * rendering the stored LLM `reading` exactly as it does today. Nothing degrades;
 * a language simply does not get the richer treatment until someone writes its
 * module.
 *
 * ## Adding a language
 *
 * One module exporting a {@link Romanizer}, one line in {@link LOADERS} keyed by
 * BCP-47 primary subtag. The loader is a dynamic `import()` on purpose: pinyin's
 * dictionary is not small, and splitting each implementation into its own lazy
 * chunk means a Spanish learner never downloads it.
 *
 * ## Purity
 *
 * `$lib/tts/languages` (a pure leaf, for the free-text → BCP-47 guess) and
 * `./types` are the only imports. No DB, no session, no `$lib/llm` — a romanizer
 * is a pure function of text plus vocabulary, and keeping it that way is what
 * lets the whole thing be unit-tested in node.
 */

import { bcp47For } from '$lib/tts/languages';

import type { Romanizer } from './types';

export type { RomanizedToken, Romanizer } from './types';
export { itemReadingTokens, localReadings, readingFold } from './item';
export type { ReadableItem } from './item';

/**
 * BCP-47 primary subtag → the module that implements it.
 *
 * Keyed on the *primary* subtag so every Mandarin spelling a learner might type
 * lands on one entry: `zh`, `zh-CN`, `zh-TW`, `zh-Hans` all resolve here.
 *
 * Cantonese is deliberately absent even though it is "Chinese": `bcp47For` maps
 * "cantonese" to `yue`, whose primary subtag is not `zh`, so it is excluded for
 * free — and correctly, because Cantonese is romanized as jyutping and running
 * it through a pinyin dictionary would produce confident nonsense. Adding it
 * means adding a jyutping module, not widening this key.
 */
const LOADERS: Readonly<Record<string, () => Promise<Romanizer>>> = {
	zh: async () => (await import('./zh')).zhRomanizer
};

/** In-flight or settled loads, so a repeat `loadRomanizer` is free. */
const pending = new Map<string, Promise<Romanizer>>();

/** Implementations that have finished loading — what {@link romanizerFor} may hand out. */
const ready = new Map<string, Romanizer>();

/**
 * The registry key for a free-text language name, or `undefined` when there is
 * no local implementation for it.
 *
 * Routes through `bcp47For`, which falls back to `en` for anything it does not
 * recognise — so an unknown or misspelled language is safely *excluded* rather
 * than guessed at.
 */
function keyFor(language: string | undefined): string | undefined {
	const primary = bcp47For(language).split('-')[0].toLowerCase();
	return primary in LOADERS ? primary : undefined;
}

/**
 * Whether this language can be romanized locally.
 *
 * The cheap, synchronous gate: a caller asks this before deciding whether to
 * kick off {@link loadRomanizer} at all, and `false` means "keep using the
 * stored LLM reading".
 */
export function hasLocalRomanizer(language: string | undefined): boolean {
	return keyFor(language) !== undefined;
}

/**
 * Load this language's romanizer, or resolve `null` when it has none.
 *
 * Call it once where a page or session starts — it fetches the implementation's
 * lazy chunk — and let rendering go through the synchronous {@link
 * romanizerFor}. The module promise is cached, so concurrent and repeat callers
 * share one fetch. A failed load rejects and clears the cache entry, so a
 * transient chunk-fetch failure can be retried rather than being remembered as
 * permanent.
 */
export async function loadRomanizer(language: string | undefined): Promise<Romanizer | null> {
	const key = keyFor(language);
	if (!key) return null;

	let load = pending.get(key);
	if (!load) {
		load = LOADERS[key]().then((romanizer) => {
			ready.set(key, romanizer);
			return romanizer;
		});
		load.catch(() => pending.delete(key));
		pending.set(key, load);
	}
	return load;
}

/**
 * This language's romanizer if it is *already* loaded, else `null`.
 *
 * Synchronous by design: rendering happens per token, many times per frame, and
 * cannot await anything. `null` here is not an error — it means either "no local
 * implementation" or "not loaded yet", and the caller's answer to both is the
 * same: render the stored LLM reading. Once {@link loadRomanizer} has resolved,
 * this returns the very same instance it did.
 */
export function romanizerFor(language: string | undefined): Romanizer | null {
	const key = keyFor(language);
	return (key && ready.get(key)) || null;
}
