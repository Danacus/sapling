/**
 * The local split. Everything downstream is index alignment, so what matters
 * here is that the pieces are the learner's own text, in order, with nothing
 * added or lost.
 */

import { describe, expect, it } from 'vitest';

import { splitSentences } from './sentences';

describe('splitSentences', () => {
	it('splits Spanish prose on its sentence-final punctuation', () => {
		expect(
			splitSentences('El sábado fuimos al restaurante. ¿Tienen una mesa para dos? ¡Claro que sí!')
		).toEqual(['El sábado fuimos al restaurante.', '¿Tienen una mesa para dos?', '¡Claro que sí!']);
	});

	it('splits Mandarin, which has no spaces to help', () => {
		expect(splitSentences('我们去了饭馆。有两个人的桌子吗？太好了！')).toEqual([
			'我们去了饭馆。',
			'有两个人的桌子吗？',
			'太好了！'
		]);
	});

	it('keeps a closing quote with the sentence it closes', () => {
		expect(splitSentences('She said "go." Then she left.')).toEqual([
			'She said "go."',
			'Then she left.'
		]);
		expect(splitSentences('姐姐问：“有桌子吗？”我说有。')).toEqual([
			'姐姐问：“有桌子吗？”',
			'我说有。'
		]);
	});

	it('treats a run of marks as one ending', () => {
		expect(splitSentences('¿Qué?! No lo sé... Bueno.')).toEqual([
			'¿Qué?!',
			'No lo sé...',
			'Bueno.'
		]);
	});

	it('splits on hard newlines even mid-sentence', () => {
		expect(splitSentences('Uno\ndos. Tres\n\ncuatro')).toEqual(['Uno', 'dos.', 'Tres', 'cuatro']);
	});

	it('gives a transcript blob one sentence per line', () => {
		const blob = [
			'so anyway I was walking home',
			'and I saw this cat',
			'   it was just sitting there   ',
			'',
			'anyway'
		].join('\n');

		expect(splitSentences(blob)).toEqual([
			'so anyway I was walking home',
			'and I saw this cat',
			'it was just sitting there',
			'anyway'
		]);
	});

	it('drops blanks and trims what is left', () => {
		expect(splitSentences('   \n\n   ')).toEqual([]);
		expect(splitSentences('')).toEqual([]);
		expect(splitSentences('  Hola.  ')).toEqual(['Hola.']);
	});

	it('loses no characters but whitespace', () => {
		const input = 'Uno. Dos!\n¿Tres? "Cuatro."\ncinco';
		const rejoined = splitSentences(input).join('').replace(/\s+/g, '');
		expect(rejoined).toBe(input.replace(/\s+/g, ''));
	});
});
