/**
 * Cutting an import into the pieces one annotate call can carry.
 *
 * The budget is not a technical limit — it is how much text a model annotates
 * *well*. Past a few thousand characters the later translations thin out and
 * the glossary stops covering the tail, and the failure is invisible: a text
 * that looks annotated but goes bare halfway down. So a long import becomes
 * several calls rather than one strained one.
 *
 * The cut falls between sentences and never inside one, for the same reason
 * `./pages` breaks where it does: everything downstream of the call — the
 * readings, the translations, the alignment check — is keyed on whole
 * sentences, and half a sentence sent alone would be annotated as if it were
 * the whole thought.
 *
 * Pure and dependency-free, like `./sentences` and `./pages`. It takes the
 * budget as an argument rather than importing one, so the test can use a small
 * number and the caller stays the only place that knows which limit applies.
 */

/**
 * Packs `sentences` into chunks of at most `maxChars`, in order.
 *
 * Greedy from the front, which is the only packing that keeps the split stable
 * as more text is added: a learner who pastes one more paragraph should get one
 * more call, not a different set of them. A sentence longer than the whole
 * budget gets a chunk to itself — it is still one call, and the alternative is
 * either dropping it or splitting mid-thought.
 *
 * The character count is the sentences' own; the prompt's numbering and the
 * vocabulary list ride along on top of it and are the reason the budget is set
 * well under what the model could physically take.
 */
export function chunkSentences(sentences: readonly string[], maxChars: number): string[][] {
	const out: string[][] = [];
	let current: string[] = [];
	let chars = 0;

	for (const sentence of sentences) {
		if (current.length > 0 && chars + sentence.length > maxChars) {
			out.push(current);
			current = [];
			chars = 0;
		}
		current.push(sentence);
		chars += sentence.length;
	}

	if (current.length > 0) out.push(current);
	return out;
}
