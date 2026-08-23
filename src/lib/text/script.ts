/**
 * Script-aware text assembly: how a sequence of word tokens becomes a sentence.
 *
 * Exists because two challenge types hand the learner a *segmented* sentence —
 * `word-order` tiles and `spot-error` tokens — and putting one back together is
 * not `tokens.join(' ')`. Chinese, Japanese, Thai and their neighbours write
 * without spaces between words, so a space-joined "我 们 想 买单" is wrong on
 * screen, wrong in the feedback banner and wrong through TTS.
 *
 * Dependency-free and pure, so both the LLM resolver (which assembles the
 * canonical sentence once, at generation time) and the play-time components
 * (which assemble whatever the learner has arranged so far) can share one
 * decision. If they diverged, a correct answer would print differently from the
 * answer it was graded against.
 */

/**
 * Scripts that do not separate words with spaces.
 *
 * Hangul is deliberately absent: modern Korean *does* space its words. Latin,
 * Cyrillic, Greek, Arabic, Devanagari and the rest space too, so the default is
 * "insert a space" and this is the exception list.
 */
const NO_SPACE_SCRIPT =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Punctuation that hugs the word before it: no space may be inserted in front. */
const CLINGS_LEFT = /^[)\]}»,.;:!?…、。，；：！？」』）】]/u;

/** Punctuation that hugs the word after it: no space may be inserted behind. */
const CLINGS_RIGHT = /[([{«¿¡「『（【]$/u;

/**
 * True when `text` is written in a script that separates words with spaces.
 *
 * Decided by the presence of any no-space character rather than by a language
 * name: the challenge carries its own text, and a profile's free-text
 * `targetLanguage` ("zh", "Mandarin", "中文", "Japanese") is a worse signal than
 * the characters themselves.
 */
export function usesInterWordSpaces(text: string): boolean {
	return !NO_SPACE_SCRIPT.test(text);
}

/**
 * True when `text` contains nothing but punctuation, symbols and whitespace.
 *
 * Such a token is never a *word*: as a word-order tile it is unplaceable
 * pedagogy (forgetting a trailing "？" is not a language mistake), so the
 * resolver merges these into their neighbour and grading ignores them.
 */
export function isPunctuationOnly(text: string): boolean {
	return /^[\p{P}\p{S}\s]+$/u.test(text);
}

/**
 * Merges punctuation-only tokens into the word they belong to.
 *
 * Trailing punctuation clings to the word before it ("favor" + "?" →
 * "favor?"), leading punctuation to the word after it ("¿" + "Nos" → "¿Nos"),
 * matching the {@link joinTokens} clinging rules. A token's other fields (its
 * reading) stay with the word; the punctuation contributes text only. A list
 * that is *all* punctuation merges to nothing.
 */
export function mergePunctuationTokens<T extends { text: string }>(tokens: readonly T[]): T[] {
	const out: T[] = [];
	let pendingLead = '';
	for (const token of tokens) {
		if (isPunctuationOnly(token.text)) {
			if (out.length > 0) {
				const last = out[out.length - 1];
				out[out.length - 1] = { ...last, text: joinTokens([last.text, token.text]) };
			} else {
				pendingLead += token.text.trim();
			}
			continue;
		}
		if (pendingLead) {
			out.push({ ...token, text: pendingLead + token.text });
			pendingLead = '';
		} else {
			out.push(token);
		}
	}
	return out;
}

/**
 * Joins segmented word tokens back into one sentence.
 *
 * The spacing rule is decided once, from *all* the tokens together — a mixed
 * sentence ("买单 please") reads as its no-space script, which is what a
 * Mandarin sentence with an English loanword in it wants. Within a spaced
 * script, punctuation tokens still cling to their neighbour, so "por" + "favor"
 * + "?" is `por favor?` and never `por favor ?`.
 *
 * Blank tokens are dropped; the result is trimmed.
 */
export function joinTokens(tokens: readonly string[]): string {
	const parts = tokens.map((token) => token.trim()).filter((token) => token.length > 0);
	if (parts.length === 0) return '';
	if (!usesInterWordSpaces(parts.join(''))) return parts.join('');

	let out = parts[0];
	for (let i = 1; i < parts.length; i++) {
		const gap = CLINGS_LEFT.test(parts[i]) || CLINGS_RIGHT.test(out) ? '' : ' ';
		out += gap + parts[i];
	}
	return out.trim();
}
