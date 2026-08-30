/**
 * Splitting a pasted text into sentences — locally, before anything is sent.
 *
 * The split happens here rather than in the model's reply for one reason: the
 * text on screen must be exactly what the learner pasted. A model handed a blob
 * and asked to return it in pieces will silently tidy punctuation, merge a
 * clause it finds ungainly and drop a line it takes for a heading, and the
 * learner would be reading a version of their article rather than their
 * article. So the app cuts, sends the pieces numbered, and asks only for
 * annotations back (`./annotate-call`).
 *
 * Pure, dependency-free and deliberately unclever. It has no opinion about
 * abbreviations or decimals; it knows sentence-final punctuation and hard
 * newlines, which between them cover prose, dialogue and the transcript blobs
 * this feature was built for. A text with no punctuation at all — a subtitle
 * dump, a lyric sheet — falls back to one sentence per line, which is exactly
 * how such a text is already laid out.
 */

/**
 * The marks a sentence ends on, in both the Latin and the CJK sets.
 *
 * `…` is in: a line that trails off is a whole sentence, and the alternative is
 * gluing it to the next one. `;` and `:` are out — they join clauses rather
 * than closing them, and a semicolon-split sentence reads as two fragments.
 */
const SENTENCE_ENDERS = new Set(['.', '!', '?', '。', '！', '？', '…']);

/**
 * Marks that ride along at the end of a sentence rather than starting the next
 * one — the closing half of every quote and bracket pair.
 *
 * Without this, `He said "go."` would split after the full stop and leave a
 * lone `"` opening the following sentence.
 */
const CLOSERS = new Set([
	'"',
	"'",
	'”',
	'’',
	'»',
	'›',
	')',
	']',
	'}',
	'」',
	'』',
	'）',
	'】',
	'〕',
	'》'
]);

/**
 * Whether `text` closes a sentence anywhere — the question a subtitle import
 * has to ask before it joins its cues.
 *
 * `./subtitles` needs it because an auto-generated transcript often carries no
 * punctuation at all, and running its cues together would then produce one
 * sentence the length of the whole video. Exported from here rather than
 * duplicated there so the two modules cannot drift over what an ending is.
 */
export function hasSentenceEnd(text: string): boolean {
	for (const char of text) if (SENTENCE_ENDERS.has(char)) return true;
	return false;
}

/** Splits one line, keeping every mark with the sentence it closes. */
function splitLine(line: string): string[] {
	const out: string[] = [];
	let start = 0;
	let i = 0;

	while (i < line.length) {
		if (!SENTENCE_ENDERS.has(line[i])) {
			i++;
			continue;
		}
		// A run of enders is one ending: "..." and "?!" close a sentence once.
		let end = i + 1;
		while (end < line.length && SENTENCE_ENDERS.has(line[end])) end++;
		while (end < line.length && CLOSERS.has(line[end])) end++;

		const piece = line.slice(start, end).trim();
		if (piece) out.push(piece);
		start = end;
		i = end;
	}

	const tail = line.slice(start).trim();
	if (tail) out.push(tail);
	return out;
}

/**
 * Splits `text` into sentences: on sentence-final punctuation, and on every
 * hard newline.
 *
 * Newlines split unconditionally, before punctuation is even looked at, because
 * a line break in a pasted text is an authorial decision — a line of dialogue,
 * a subtitle cue, a bullet — and running two of them together to satisfy a
 * missing full stop would misrepresent the source. That is also what makes the
 * punctuation-free case work without a special path.
 *
 * Blank pieces are dropped and every survivor is trimmed, so leading indentation
 * and the blank lines between paragraphs cost nothing.
 */
export function splitSentences(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		out.push(...splitLine(line));
	}
	return out;
}
