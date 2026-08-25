/**
 * The contract a local romanizer satisfies, and the token shape it produces.
 *
 * Kept in its own leaf module so `./index` (the registry, which knows about
 * language tags) and `./zh` (the implementation, which knows about pinyin) can
 * both name these types without importing each other — the registry reaches its
 * implementations only through a dynamic `import()`, so a static edge in either
 * direction would defeat the code-splitting the registry exists to get.
 */

/**
 * One display token of target-language text with its Latin reading.
 *
 * The unit of *presentation*, not of linguistics: a token is whatever the UI
 * wants to draw as one ruby-annotated cell and make one hide/show decision
 * about. Grouping therefore follows the learner's own vocabulary rather than a
 * general-purpose segmenter — a word they are studying should be one cell with
 * one reading above it, so that "hide the readings for words I know" can be
 * keyed by the term itself.
 */
export interface RomanizedToken {
	/**
	 * The token exactly as it appears in the source text.
	 *
	 * Verbatim, whitespace and punctuation included: concatenating every token's
	 * `text` reproduces the input character for character. That invariant is what
	 * lets a caller render tokens instead of the original string without ever
	 * having to diff the two.
	 */
	text: string;
	/**
	 * Latin reading, or `null` for spans that need none — Latin runs, digits,
	 * punctuation, whitespace, and the cloze gap `___`.
	 *
	 * `null` means "there is nothing to romanize here", never "we failed to":
	 * a caller renders such a token bare, with no ruby slot reserved above it.
	 */
	reading: string | null;
}

/** A language's local, offline romanizer. */
export interface Romanizer {
	/**
	 * Tokenize `text` into aligned tokens.
	 *
	 * `terms` is the learner's vocabulary (knowledge-item terms); tokens are
	 * grouped to match those terms where they occur, so callers can key per-word
	 * decisions — hide this reading, link to this word's ledger entry — by term.
	 * Characters not covered by any term become single-character tokens; passing
	 * no terms at all is valid and yields the fully split reading.
	 *
	 * Implementations must romanize the *whole* `text` in one pass. Readings are
	 * context-dependent in every language worth romanizing, so a per-token call
	 * would be a correctness bug, not an optimization (see `./zh`).
	 */
	tokenize(text: string, terms?: readonly string[]): RomanizedToken[];
}
