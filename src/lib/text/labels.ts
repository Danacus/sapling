/**
 * The collision key for a rendered *label* — a match-pairs tile, a word-bank
 * chip. Two labels the learner cannot tell apart make a round unplayable: they
 * see two identical tiles and have to guess which twin belongs to which pair,
 * and a correct guess is graded wrong half the time.
 *
 * Deliberately not {@link termKey} from `./keys`: that adds NFC normalization,
 * which is right for asking whether two *cards* name the same word but would
 * merge two rendered labels that differ only by Unicode composition. This key
 * is exactly the normalization the match-pairs builder has always used — trim,
 * lower-case, collapse internal whitespace — so moving it out of
 * `$lib/llm/resolve-helpers` changes nothing about which labels collide.
 */
export function labelKey(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, ' ');
}
