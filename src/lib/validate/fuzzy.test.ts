import { describe, expect, it } from 'vitest';
import type {
	ClozeChallenge,
	MatchPairsChallenge,
	MultipleChoiceChallenge,
	TypedTranslationChallenge
} from '$lib/types';
import { checkAnswer, checkChallenge, editDistance, normalize, validateAnswer } from './fuzzy';

describe('normalize', () => {
	it('lowercases, trims and collapses internal whitespace', () => {
		expect(normalize('  Hello   World  ')).toBe('hello world');
	});

	it('strips surrounding/separating punctuation', () => {
		expect(normalize('¿Qué tal?')).toBe('qué tal');
		expect(normalize("'hello'")).toBe('hello');
		expect(normalize('Hi, there!')).toBe('hi there');
	});

	it('keeps intra-word apostrophes meaningful (not stripped)', () => {
		expect(normalize("l'eau")).toBe("l'eau");
		expect(normalize("l'eau")).not.toBe('leau');
	});

	it('keeps intra-word hyphens meaningful (not stripped)', () => {
		expect(normalize('long-term')).toBe('long-term');
		expect(normalize('well - known')).toBe('well known'); // hyphen surrounded by spaces is a separator
	});

	it('does not fold diacritics by default', () => {
		expect(normalize('café')).toBe('café');
	});

	it('folds diacritics when requested', () => {
		expect(normalize('café', { foldDiacritics: true })).toBe('cafe');
		expect(normalize('Über', { foldDiacritics: true })).toBe('uber');
		expect(normalize('naïve', { foldDiacritics: true })).toBe('naive');
	});

	it('leaves non-Latin scripts untouched aside from whitespace/punctuation', () => {
		expect(normalize('你好，世界！')).toBe('你好 世界');
		expect(normalize('こんにちは')).toBe('こんにちは');
	});

	it('handles empty and whitespace-only input', () => {
		expect(normalize('')).toBe('');
		expect(normalize('   ')).toBe('');
		expect(normalize('\t\n  \t')).toBe('');
	});
});

describe('editDistance', () => {
	it('is 0 for identical strings', () => {
		expect(editDistance('same', 'same')).toBe(0);
		expect(editDistance('', '')).toBe(0);
	});

	it('handles pure insertions/deletions against an empty string', () => {
		expect(editDistance('', 'abc')).toBe(3);
		expect(editDistance('abc', '')).toBe(3);
	});

	it('matches the classic Levenshtein example', () => {
		expect(editDistance('kitten', 'sitting')).toBe(3);
	});

	it('counts an adjacent transposition as a single edit (Damerau, not plain Levenshtein)', () => {
		expect(editDistance('hte', 'the')).toBe(1);
		expect(editDistance('ac', 'ca')).toBe(1);
		expect(editDistance('shcool', 'school')).toBe(1);
	});

	it('is symmetric', () => {
		expect(editDistance('kitten', 'sitting')).toBe(editDistance('sitting', 'kitten'));
		expect(editDistance('hte', 'the')).toBe(editDistance('the', 'hte'));
	});

	it('operates on code points, working correctly for non-Latin scripts', () => {
		expect(editDistance('你好', '你好')).toBe(0);
		expect(editDistance('你好', '你号')).toBe(1);
		expect(editDistance('こんにちは', 'こんにちわ')).toBe(1);
	});
});

describe('validateAnswer: correct tier', () => {
	it('matches exactly', () => {
		const result = validateAnswer('hello', ['hello']);
		expect(result.verdict).toBe('correct');
		expect(result.closestAccepted).toBe('hello');
		expect(result.distance).toBe(0);
	});

	it('is case-insensitive (case difference -> correct, not almost)', () => {
		expect(validateAnswer('HELLO', ['hello']).verdict).toBe('correct');
		expect(validateAnswer('hello', ['HELLO']).verdict).toBe('correct');
		expect(validateAnswer('HeLLo', ['hello']).verdict).toBe('correct');
	});

	it('ignores surrounding whitespace and internal whitespace runs', () => {
		expect(validateAnswer('  hello world  ', ['hello world']).verdict).toBe('correct');
		expect(validateAnswer('hello    world', ['hello world']).verdict).toBe('correct');
	});

	it('matches multi-word answers exactly', () => {
		const result = validateAnswer('Good Morning', ['good morning']);
		expect(result.verdict).toBe('correct');
	});

	it('ignores separating punctuation', () => {
		expect(validateAnswer('¿Qué tal?', ['¿Qué tal?']).verdict).toBe('correct');
		expect(validateAnswer("don't stop", ["don't stop"]).verdict).toBe('correct');
	});

	it('accepts the diacritics-intact accented form as correct, not just almost', () => {
		expect(validateAnswer('café', ['café']).verdict).toBe('correct');
	});

	it('picks the matching entry when multiple accepted answers are given', () => {
		const result = validateAnswer('hello', ['goodbye', 'hello']);
		expect(result.verdict).toBe('correct');
		expect(result.closestAccepted).toBe('hello');
		expect(result.distance).toBe(0);
	});
});

describe('validateAnswer: almost tier (diacritic folding)', () => {
	it('accepts a missing accent as almost, showing the canonical accented form', () => {
		const result = validateAnswer('cafe', ['café']);
		expect(result.verdict).toBe('almost');
		expect(result.closestAccepted).toBe('café');
		expect(result.distance).toBe(0);
	});

	it('works for u-umlaut / u', () => {
		const result = validateAnswer('uber', ['über']);
		expect(result.verdict).toBe('almost');
		expect(result.closestAccepted).toBe('über');
	});

	it('accepts extra accents the accepted answer does not have, symmetrically', () => {
		const result = validateAnswer('übér', ['uber']);
		expect(result.verdict).toBe('almost');
	});
});

describe('validateAnswer: almost tier (edit-distance typo tolerance)', () => {
	it('tolerates a one-character typo on a medium-length word', () => {
		const result = validateAnswer('helo', ['hello']);
		expect(result.verdict).toBe('almost');
		expect(result.closestAccepted).toBe('hello');
		expect(result.distance).toBe(1);
	});

	it('tolerates a transposition typo within threshold', () => {
		// "school" is 6 chars -> threshold 1; one adjacent transposition = distance 1.
		const result = validateAnswer('shcool', ['school']);
		expect(result.verdict).toBe('almost');
		expect(result.distance).toBe(1);
	});

	it('rejects a typo that exceeds the threshold for that word length', () => {
		// "hi" is 2 chars -> threshold 0, so any single-character typo is wrong.
		const result = validateAnswer('hu', ['hi']);
		expect(result.verdict).toBe('wrong');
	});

	it('gives short words (<=3 chars) zero typo tolerance, even for a transposition', () => {
		// "the" is 3 chars -> threshold 0. Distance is correctly computed as 1
		// (a transposition, not 2), but that's still over budget for a 3-letter word.
		const result = validateAnswer('hte', ['the']);
		expect(result.distance).toBe(1);
		expect(result.verdict).toBe('wrong');
	});

	it('treats punctuation-only differences as within tolerance', () => {
		// "¿Qué tal?" normalizes+folds to "que tal" (7 chars -> threshold 1),
		// which exactly matches the folded/depunctuated given answer.
		const result = validateAnswer('que tal', ['¿Qué tal?']);
		expect(result.verdict).toBe('almost');
		expect(result.closestAccepted).toBe('¿Qué tal?');
		expect(result.distance).toBe(0);
	});
});

describe('validateAnswer: threshold boundaries', () => {
	const cases: { len: number; threshold: number }[] = [
		{ len: 3, threshold: 0 },
		{ len: 4, threshold: 1 },
		{ len: 7, threshold: 1 },
		{ len: 8, threshold: 2 },
		{ len: 12, threshold: 2 },
		{ len: 13, threshold: 3 }
	];

	for (const { len, threshold } of cases) {
		const accepted = 'a'.repeat(len);

		it(`length ${len} (threshold ${threshold}): distance == threshold is almost`, () => {
			if (threshold === 0) {
				// distance 0 at threshold 0 is the exact-match tier, i.e. 'correct'.
				expect(validateAnswer(accepted, [accepted]).verdict).toBe('correct');
				return;
			}
			const given = accepted + 'b'.repeat(threshold);
			const result = validateAnswer(given, [accepted]);
			expect(result.distance).toBe(threshold);
			expect(result.verdict).toBe('almost');
		});

		it(`length ${len} (threshold ${threshold}): distance == threshold + 1 is wrong`, () => {
			const given = accepted + 'b'.repeat(threshold + 1);
			const result = validateAnswer(given, [accepted]);
			expect(result.distance).toBe(threshold + 1);
			expect(result.verdict).toBe('wrong');
		});
	}
});

describe('validateAnswer: wrong tier', () => {
	it('rejects an unrelated answer', () => {
		const result = validateAnswer('banana', ['apple']);
		expect(result.verdict).toBe('wrong');
	});

	it('reports the closest accepted answer even when nothing is close enough', () => {
		// "hi" is 2 chars -> threshold 0, so a 2-edit typo stays wrong, but
		// closestAccepted/distance still point at the nearest candidate.
		const result = validateAnswer('ho', ['hi', 'banana']);
		expect(result.verdict).toBe('wrong');
		expect(result.closestAccepted).toBe('hi');
		expect(result.distance).toBe(1);
	});
});

describe('validateAnswer: closestAccepted tracks the global nearest match', () => {
	it('picks the closest accepted answer across the whole list, independent of the winning verdict', () => {
		const result = validateAnswer('appel', ['apple', 'banana']);
		expect(result.closestAccepted).toBe('apple');
		expect(result.distance).toBe(1);
		// "apple" is 5 chars -> threshold 1, so this one-edit typo is almost.
		expect(result.verdict).toBe('almost');
	});
});

describe('validateAnswer: edge cases', () => {
	it('treats empty input as wrong', () => {
		const result = validateAnswer('', ['hello']);
		expect(result.verdict).toBe('wrong');
		expect(result.closestAccepted).toBe('hello');
		expect(result.distance).toBe(5);
	});

	it('treats whitespace-only input as wrong', () => {
		const result = validateAnswer('   ', ['hi']);
		expect(result.verdict).toBe('wrong');
	});

	it('handles an empty accepted-answers list', () => {
		const result = validateAnswer('anything', []);
		expect(result.verdict).toBe('wrong');
		expect(result.closestAccepted).toBe('');
		expect(result.distance).toBe(Infinity);
	});

	it('breaks ties between equally-close accepted answers by picking the first', () => {
		const result = validateAnswer('cet', ['cat', 'cot']);
		expect(result.distance).toBe(1);
		expect(result.closestAccepted).toBe('cat');
	});

	it('keeps apostrophes meaningful: "l\'eau" vs "leau" is a fuzzy match, not exact', () => {
		const exact = validateAnswer("l'eau", ["l'eau"]);
		expect(exact.verdict).toBe('correct');

		const withoutApostrophe = validateAnswer('leau', ["l'eau"]);
		expect(withoutApostrophe.verdict).toBe('almost');
		expect(withoutApostrophe.verdict).not.toBe('correct');
	});

	it('handles non-Latin (CJK) scripts without mangling or false positives', () => {
		expect(validateAnswer('你好', ['你好']).verdict).toBe('correct');
		// 2 chars -> threshold 0, so a one-character difference is wrong.
		expect(validateAnswer('你号', ['你好']).verdict).toBe('wrong');
	});

	it('handles non-Latin scripts with typo tolerance at longer lengths', () => {
		// "こんにちは" is 5 chars -> threshold 1.
		const result = validateAnswer('こんにちわ', ['こんにちは']);
		expect(result.verdict).toBe('almost');
		expect(result.distance).toBe(1);
	});

	it('can disable the fuzzy tier entirely via opts.fuzzy', () => {
		const result = validateAnswer('helo', ['hello'], { fuzzy: false });
		expect(result.verdict).toBe('wrong');
		expect(result.distance).toBe(1); // still reported for feedback display
	});
});

describe('checkAnswer', () => {
	it('is a thin wrapper returning just the verdict', () => {
		expect(checkAnswer('hello', ['hello'])).toBe('correct');
		expect(checkAnswer('helo', ['hello'])).toBe('almost');
		expect(checkAnswer('goodbye', ['hello'])).toBe('wrong');
	});
});

describe('checkChallenge', () => {
	const cloze: ClozeChallenge = {
		id: 'c1',
		type: 'cloze',
		direction: 'toTarget',
		sentence: 'Ich ___ nach Hause.',
		acceptedAnswers: ['gehe'],
		translationHint: 'I am going home.',
		itemIds: ['item1']
	};

	const typedTranslation: TypedTranslationChallenge = {
		id: 't1',
		type: 'typed-translation',
		direction: 'toTarget',
		prompt: 'good morning',
		acceptedAnswers: ['buenos días', 'buenos dias'],
		itemIds: ['item1']
	};

	const multipleChoice: MultipleChoiceChallenge = {
		id: 'm1',
		type: 'multiple-choice',
		direction: 'toNative',
		prompt: 'casa',
		options: ['house', 'car', 'tree', 'dog'],
		correctIndex: 0,
		itemIds: ['item1']
	};

	const matchPairs: MatchPairsChallenge = {
		id: 'p1',
		type: 'match-pairs',
		direction: 'toTarget',
		pairs: [
			{ a: 'hola', b: 'hello' },
			{ a: 'adiós', b: 'goodbye' }
		],
		itemIds: ['item1']
	};

	it('grades a cloze challenge against its accepted answers', () => {
		expect(checkChallenge(cloze, 'gehe')).toBe('correct');
		expect(checkChallenge(cloze, 'gehee')).toBe('almost');
		expect(checkChallenge(cloze, 'komme')).toBe('wrong');
	});

	it('grades a typed-translation challenge, taking the best of several accepted answers', () => {
		expect(checkChallenge(typedTranslation, 'Buenos Días')).toBe('correct');
		expect(checkChallenge(typedTranslation, 'buenos dias')).toBe('correct');
		expect(checkChallenge(typedTranslation, 'buenos dia')).toBe('almost');
	});

	it('grades a multiple-choice challenge against the correct option text', () => {
		expect(checkChallenge(multipleChoice, 'house')).toBe('correct');
		expect(checkChallenge(multipleChoice, 'House')).toBe('correct');
		expect(checkChallenge(multipleChoice, 'car')).toBe('wrong');
	});

	it('grades a match-pairs "a::b" answer against the declared pairs', () => {
		expect(checkChallenge(matchPairs, 'hola::hello')).toBe('correct');
		expect(checkChallenge(matchPairs, 'hola::goodbye')).toBe('wrong');
		expect(checkChallenge(matchPairs, 'not a pair')).toBe('wrong');
	});
});
