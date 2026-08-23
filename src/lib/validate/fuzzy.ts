/**
 * Fuzzy answer validation.
 *
 * Learners should not be punished for a missing accent, a stray article or a
 * one-character typo, but they should be told about it — hence the three-way
 * `Verdict` ('almost' means accepted-with-a-nudge).
 *
 * Everything here is pure and synchronous: no network calls, no randomness.
 * This is the "free" grading path that runs before (or instead of) an LLM
 * judge call.
 */

import type { Challenge, Verdict } from '$lib/types';

/** Options for {@link normalize}. */
export interface NormalizeOptions {
	/**
	 * Also fold away diacritics/accents (NFD-decompose then strip combining
	 * marks), e.g. `"café"` -> `"cafe"`. Defaults to `false` so callers can
	 * distinguish an exact accented match from an accent-only mismatch.
	 */
	foldDiacritics?: boolean;
}

/** Options for {@link validateAnswer}. */
export interface ValidateAnswerOptions {
	/**
	 * Whether the diacritic-folded / edit-distance based "almost" tier is
	 * evaluated at all. Defaults to `true`. Setting this to `false` reduces
	 * grading to "exact normalized match, or wrong" — useful for challenge
	 * types where near-misses shouldn't be rewarded.
	 */
	fuzzy?: boolean;
}

/** Result of {@link validateAnswer}. */
export interface ValidateAnswerResult {
	verdict: Verdict;
	/** The accepted answer closest (smallest edit distance) to `given`. */
	closestAccepted: string;
	/**
	 * Edit distance from `given` to `closestAccepted`, computed on
	 * normalized (and, unless disabled, diacritic-folded) strings.
	 * `Infinity` when `acceptedAnswers` is empty.
	 */
	distance: number;
}

// Characters we keep even though they're in a Unicode punctuation category,
// but only when they sit between two "word" characters (letters/digits) —
// i.e. they're doing morphological work ("l'eau", "long-term") rather than
// separating words or bracketing a sentence ("¿Qué tal?", "'hello'").
const INTRA_WORD_PUNCTUATION = /['’-]/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Lowercase, trim, collapse internal whitespace, and strip punctuation.
 *
 * Punctuation stripping is Unicode-aware (uses `\p{P}`/`\p{S}`, so it works
 * on non-Latin scripts and full-width punctuation too) and keeps apostrophes
 * and hyphens when they sit inside a word (`"l'eau"`, `"long-term"`) since
 * those are meaningful — dropping them entirely would make e.g. "l'eau" and
 * "leau" indistinguishable at the normalization stage. They're still free to
 * be treated as "close enough" by the fuzzy edit-distance tier in
 * {@link validateAnswer}.
 *
 * With `opts.foldDiacritics`, accents/diacritics are also stripped
 * (`"café"` -> `"cafe"`).
 */
export function normalize(input: string, opts: NormalizeOptions = {}): string {
	let s = input.normalize('NFC').toLowerCase();

	s = s.replace(/[\p{P}\p{S}]/gu, (ch, offset: number) => {
		if (INTRA_WORD_PUNCTUATION.test(ch)) {
			const prev = s[offset - 1];
			const next = s[offset + 1];
			if (prev && next && WORD_CHAR.test(prev) && WORD_CHAR.test(next)) {
				return ch;
			}
		}
		return ' ';
	});

	s = s.replace(/\s+/g, ' ').trim();

	if (opts.foldDiacritics) {
		s = foldDiacritics(s);
	}

	return s;
}

/**
 * NFD-decompose and drop combining marks, e.g. `"café"` -> `"cafe"`,
 * `"nǐ hǎo"` -> `"ni hao"`.
 *
 * Exported because grading is not its only customer: the LLM resolver folds the
 * readings it is handed into extra `acceptedAnswers`, so a learner typing
 * toneless pinyin is graded correct by the ordinary (free) matcher rather than
 * by script-aware special cases — and the model never spends tokens spelling
 * those variants out.
 */
export function foldDiacritics(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.normalize('NFC');
}

/**
 * Damerau-Levenshtein edit distance (optimal string alignment variant: each
 * substring may be transposed at most once). Hand-rolled, no dependencies.
 *
 * Operates on Unicode code points (not UTF-16 code units) via `Array.from`,
 * so it behaves correctly on astral-plane characters and doesn't need any
 * special-casing for non-Latin scripts.
 */
export function editDistance(a: string, b: string): number {
	const s = Array.from(a);
	const t = Array.from(b);
	const m = s.length;
	const n = t.length;

	if (m === 0) return n;
	if (n === 0) return m;

	// d[i][j] = distance between s[0..i) and t[0..j)
	const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = 0; i <= m; i++) d[i][0] = i;
	for (let j = 0; j <= n; j++) d[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const cost = s[i - 1] === t[j - 1] ? 0 : 1;
			let best = Math.min(
				d[i - 1][j] + 1, // deletion
				d[i][j - 1] + 1, // insertion
				d[i - 1][j - 1] + cost // substitution (or no-op)
			);
			if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
				best = Math.min(best, d[i - 2][j - 2] + 1); // adjacent transposition
			}
			d[i][j] = best;
		}
	}

	return d[m][n];
}

/**
 * Length-scaled "how many edits still count as a typo" threshold, applied
 * to the normalized length of the accepted answer.
 *
 * | accepted length | threshold |
 * |------------------|-----------|
 * | 1–3              | 0         |
 * | 4–7              | 1         |
 * | 8–12             | 2         |
 * | 13+              | 3         |
 */
function thresholdFor(acceptedLength: number): number {
	if (acceptedLength <= 3) return 0;
	if (acceptedLength <= 7) return 1;
	if (acceptedLength <= 12) return 2;
	return 3;
}

function verdictRank(v: Verdict): number {
	return v === 'correct' ? 2 : v === 'almost' ? 1 : 0;
}

/**
 * Grades a free-text answer against every accepted answer, keeping the best
 * outcome:
 *
 * 1. Normalized (diacritics intact) exact match -> `'correct'`.
 * 2. Diacritic-folded exact match, or Damerau-Levenshtein distance (on
 *    normalized + folded strings) within {@link thresholdFor} of the
 *    accepted answer's length -> `'almost'`.
 * 3. Otherwise -> `'wrong'`.
 *
 * `closestAccepted`/`distance` always describe the nearest accepted answer
 * by edit distance, regardless of which tier actually decided the verdict —
 * they're for feedback display ("you meant: …"), not for the grading logic.
 */
export function validateAnswer(
	given: string,
	acceptedAnswers: string[],
	opts: ValidateAnswerOptions = {}
): ValidateAnswerResult {
	if (acceptedAnswers.length === 0) {
		return { verdict: 'wrong', closestAccepted: '', distance: Infinity };
	}

	const fuzzy = opts.fuzzy ?? true;
	const normGiven = normalize(given);
	const foldGiven = normalize(given, { foldDiacritics: true });

	let bestVerdict: Verdict = 'wrong';
	let closestAccepted = acceptedAnswers[0];
	let closestDistance = Infinity;

	for (const accepted of acceptedAnswers) {
		const normAccepted = normalize(accepted);
		const foldAccepted = normalize(accepted, { foldDiacritics: true });
		const distance = editDistance(foldGiven, foldAccepted);

		if (distance < closestDistance) {
			closestDistance = distance;
			closestAccepted = accepted;
		}

		let verdict: Verdict;
		if (normGiven.length > 0 && normGiven === normAccepted) {
			verdict = 'correct';
		} else if (fuzzy && distance <= thresholdFor(foldAccepted.length)) {
			verdict = 'almost';
		} else {
			verdict = 'wrong';
		}

		if (verdictRank(verdict) > verdictRank(bestVerdict)) {
			bestVerdict = verdict;
		}
	}

	return { verdict: bestVerdict, closestAccepted, distance: closestDistance };
}

/** Grades a free-text answer against the accepted answers. */
export function checkAnswer(given: string, accepted: string[]): Verdict {
	return validateAnswer(given, accepted).verdict;
}

/** Grades any challenge; dispatches on `challenge.type`. */
export function checkChallenge(challenge: Challenge, answerGiven: string): Verdict {
	switch (challenge.type) {
		case 'cloze':
		case 'typed-translation':
			return checkAnswer(answerGiven, challenge.acceptedAnswers);

		case 'multiple-choice': {
			const correctOption = challenge.options[challenge.correctIndex];
			return checkAnswer(answerGiven, [correctOption]);
		}

		case 'match-pairs': {
			// Match-pairs is normally graded interactively in the UI (each tap
			// resolves one pair), not via a single free-text answer. This
			// dispatcher is kept total by accepting an "a::b" / "a|b" encoding
			// of one resolved pair, matched against the challenge's pairs.
			const parts = answerGiven.split(/::|\|/).map((p) => p.trim());
			if (parts.length !== 2) return 'wrong';
			const [a, b] = parts;
			const hit = challenge.pairs.some(
				(pair) => normalize(a) === normalize(pair.a) && normalize(b) === normalize(pair.b)
			);
			return hit ? 'correct' : 'wrong';
		}

		case 'word-order': {
			// Tapped tiles, not typed text: the component grades by comparing the
			// chosen token sequence to `answerTokens`. This dispatcher stays total by
			// grading the assembled sentence, which is what the component reports as
			// `answerGiven` — and it is an exact comparison, never fuzzy, because the
			// learner picked from a closed set rather than spelling anything.
			return normalize(answerGiven) === normalize(challenge.answer) ? 'correct' : 'wrong';
		}

		case 'spot-error': {
			// The answer is the *wrong* word — the one the learner is asked to tap.
			return normalize(answerGiven) === normalize(challenge.tokens[challenge.correctIndex])
				? 'correct'
				: 'wrong';
		}

		default: {
			const _exhaustive: never = challenge;
			return _exhaustive;
		}
	}
}
