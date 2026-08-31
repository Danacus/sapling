/**
 * The one way two pieces of text are asked whether they name the same word.
 *
 * Four modules used to answer that question with four private one-liners — the
 * lesson resolver's term citations, the session engine's mistake hints, the
 * assistant's duplicate guard and reading mode's `wordKey` — and they disagreed
 * in small ways: some collapsed internal spaces, some normalized to NFC, one did
 * neither. Nothing had gone wrong yet, but the whole point of a key is that both
 * sides of a lookup compute it the same way, and four implementations are four
 * chances for one of them to drift. So the union of all four lives here, in the
 * dependency-free module both halves of the app can already import.
 *
 * ## Why there are two keys, not one
 *
 * A word is not its spelling. 长 is `cháng` ("long") and `zhǎng` ("to grow"),
 * and a learner studying both has **two cards with one term** — different
 * meanings, different review histories, different schedules. Everything that
 * stores a card already copes (`items.id` is a surrogate, and reviews, SRS and
 * sync are all id-keyed); what needed a rule is every seam where a card is
 * addressed *by what it says* rather than by its id. There the term alone is
 * ambiguous and the reading is what resolves it, so {@link termKey} answers
 * "same spelling?", {@link readingKey} answers "same reading?", and
 * {@link cardKey} is the pair that identifies one card.
 *
 * **Tones are never folded here.** They are the entire difference between the
 * two 长s, so a key that dropped them would merge exactly the cards this module
 * exists to keep apart. `sameRomanization` in `$lib/conversation/diff` folds
 * them deliberately and is a different question — how forgiving to be about what
 * a *learner typed* — which is why the two are not shared.
 */

/**
 * "Do these name the same spelling?" — trimmed, NFC, lower-cased, and internal
 * whitespace collapsed to single spaces.
 *
 * No diacritic folding: in the language's own spelling every mark counts, and
 * `ecole` is not `école`. NFC because a term typed with a combining accent and
 * one typed with the precomposed character are the same word and the learner has
 * no way to tell which they have. Space collapsing because a multi-word term
 * ("por  favor") is the same term however it was spaced.
 */
export function termKey(s: string): string {
	return s.trim().normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * "Do these name the same reading?" — the same normalization, except that *all*
 * whitespace goes rather than being collapsed.
 *
 * A reading is spaced by whoever wrote it: a romanizer emits `zì xíng chē`, a
 * model writes `zìxíngchē`, and a learner types whichever they saw. The syllable
 * break carries no information the comparison wants, so it is removed entirely —
 * which is also what lets a multi-syllable token's reading be matched against a
 * whole term's.
 *
 * Tone marks stay. See the module note.
 */
export function readingKey(s: string): string {
	return s.trim().normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

/**
 * The identity of one card at a seam that has no ids: its spelling, plus its
 * reading when it has one.
 *
 * A card with no reading keys as its bare term, which is what keeps this
 * backwards compatible with every collection written before homographs were
 * allowed — and why a reading-less card still collides with every spelling of
 * itself in `add_words`. There is no way to tell which 长 a bare 长 meant, and
 * guessing would fork an SRS history in two.
 */
export function cardKey(term: string, romanization?: string | null): string {
	const key = termKey(term);
	const reading = romanization ? readingKey(romanization) : '';
	return reading ? `${key} ${reading}` : key;
}

/**
 * Whether two cards may not both exist: the same spelling, and a reading that
 * does not tell them apart.
 *
 * Deliberately asymmetric about missing readings. Two spellings with two
 * different readings are two words and both are welcome; a spelling with *no*
 * reading collides with every card that shares it, because a bare 长 is a claim
 * about a spelling and there is nothing in it to distinguish.
 */
export function sameCard(
	a: { term: string; romanization?: string | null },
	b: { term: string; romanization?: string | null }
): boolean {
	if (termKey(a.term) !== termKey(b.term)) return false;
	if (!a.romanization || !b.romanization) return true;
	return readingKey(a.romanization) === readingKey(b.romanization);
}
