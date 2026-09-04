/**
 * Word counts for structural difficulty.
 *
 * `./def` restricts a stored-type def to importing zod, `$lib/types` and
 * `$lib/validate` — a boundary worth keeping, since it is what stops the
 * stored half of the challenge union from growing a dependency on the rest of
 * the app. But a length knob cannot just split on spaces: Chinese and Japanese
 * run their words together, so counting "words" needs the same segmenter the
 * reader and the romanizer already share (`$lib/text/segmentWords`). This file
 * is the one, narrow exception the rule allows — a sibling a def imports
 * instead of reaching for `$lib/text` itself, so the allowed-imports test in
 * `./registry.test.ts` still only has to whitelist zod, `$lib/types` and
 * `$lib/validate` for the defs themselves.
 */

import { segmentWords } from '$lib/text';

/** How many word-like segments `text` is made of — every def's length knob. */
export function wordCount(text: string): number {
	return segmentWords(text).filter((segment) => segment.isWord).length;
}
