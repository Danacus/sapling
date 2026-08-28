/**
 * `cloze` — one target-language word missing from a target-language sentence.
 *
 * The model supplies the sentence in three pieces rather than one string with a
 * marker in it: the blank is then placed by the app, always exactly once, and
 * the answer's reading sits in a field of its own that the pre-answer view never
 * touches.
 *
 * The only type that never drops: every defect it can have is cosmetic. The
 * sentence is rebuilt by concatenating the two halves around the blank, which
 * is what guarantees exactly one gap in exactly the place the answer came from,
 * and a romanization structurally cannot spell out the missing word.
 */

import { z } from 'zod';
import {
	CLOZE_GAP,
	answerVariants,
	clozeSentenceRomanization,
	clozeWordBank,
	optionalString
} from '../resolve-helpers';
import { clozePartSchema, generatedBase, nonEmpty, targetTextSchema } from './primitives';
import type { WireTypeDef } from './def';

export const generatedClozeSchema = z.object({
	type: z.literal('cloze'),
	before: clozePartSchema,
	answer: targetTextSchema,
	after: clozePartSchema,
	hintNative: nonEmpty,
	/**
	 * Three to five wrong candidates turn the challenge into a word bank; null
	 * means the learner types the answer. Deliberately *not* length-constrained:
	 * a bank of the wrong size is a cosmetic defect, and rejecting a challenge we
	 * already paid for over it would be a poor trade. The resolver decides what
	 * survives.
	 */
	distractorWords: z.array(targetTextSchema).nullish(),
	...generatedBase
});

export type GeneratedCloze = z.infer<typeof generatedClozeSchema>;

export const clozeDef = {
	type: 'cloze',
	schema: generatedClozeSchema,
	promptSpec:
		'cloze — one target-language word missing from a target-language sentence. {before:TargetText, answer:TargetText, after:TargetText, hintNative, distractorWords:[3-5 TargetText] or null} e.g. {"type":"cloze","before":{"text":"你好，请给我一份","reading":"Nǐ hǎo, qǐng gěi wǒ yī fèn"},"answer":{"text":"菜单","reading":"càidān"},"after":{"text":"。","reading":"."},"hintNative":"Hello, could I have a menu, please?","distractorWords":[{"text":"筷子","reading":"kuàizi"},{"text":"茶","reading":"chá"},{"text":"水","reading":"shuǐ"}],"itemIds":["i3"],"explanation":"份 (fèn) is the measure word for a menu or a portion."} — before and after carry their own spacing and punctuation and the app puts the blank between them; either may be {"text":"","reading":null}. hintNative is the whole sentence in the native language. distractorWords null means the learner types the answer.',
	rulesSpec: '- Cloze sentences use only vocabulary at or below the learner level.',
	correctiveSpec: 'cloze {before,answer,after,hintNative}',

	// The only type with two fixtures per scenario, and deliberately so: one
	// with a word bank to tap and one without, because the resolver's two cloze
	// modes are otherwise never both exercised by a practice lesson.
	fixtures: {
		spanish: [
			{
				order: 1,
				challenge: {
					type: 'cloze',
					before: { text: '¿Nos trae la ', reading: null },
					answer: { text: 'cuenta', reading: null },
					after: { text: ', por favor? Tenemos prisa.', reading: null },
					hintNative: 'Could you bring us the bill, please? We are in a hurry.',
					distractorWords: [
						{ text: 'carta', reading: null },
						{ text: 'propina', reading: null },
						{ text: 'mesa', reading: null }
					],
					itemIds: ['la cuenta'],
					explanation: null
				}
			},
			{
				order: 4,
				challenge: {
					// No distractorWords: the learner types this one.
					type: 'cloze',
					before: { text: '¿Ya podemos ', reading: null },
					answer: { text: 'pedir', reading: null },
					after: { text: '?', reading: null },
					hintNative: 'Can we order now?',
					distractorWords: null,
					itemIds: ['pedir'],
					explanation: null
				}
			}
		],
		mandarin: [
			{
				order: 2,
				challenge: {
					type: 'cloze',
					// The reading of the answer travels in `answer`, never in `before` or
					// `after`, so the pinyin line under the sentence cannot spell out the
					// word behind the blank.
					before: { text: '你好，请给我一份', reading: 'Nǐ hǎo, qǐng gěi wǒ yī fèn' },
					answer: { text: '菜单', reading: 'càidān' },
					after: { text: '。', reading: '.' },
					hintNative: 'Hello, could I have a menu, please?',
					distractorWords: [
						{ text: '筷子', reading: 'kuàizi' },
						{ text: '茶', reading: 'chá' },
						{ text: '水', reading: 'shuǐ' }
					],
					itemIds: ['菜单'],
					explanation: '份 (fèn) is the measure word for a menu or a portion.'
				}
			},
			{
				order: 4,
				challenge: {
					type: 'cloze',
					before: { text: '我们想', reading: 'Wǒmen xiǎng' },
					answer: { text: '买单', reading: 'mǎidān' },
					after: { text: '。', reading: '.' },
					hintNative: 'We would like to pay the bill.',
					distractorWords: null,
					itemIds: ['买单'],
					explanation: null
				}
			}
		]
	},

	resolve(generated, { base, rng }) {
		return {
			...base,
			type: 'cloze',
			direction: 'toTarget',
			// The halves carry their own spacing and punctuation; concatenating
			// them verbatim is what guarantees exactly one blank, in the one
			// place the answer was taken from.
			sentence: generated.before.text + CLOZE_GAP + generated.after.text,
			...clozeSentenceRomanization(generated),
			acceptedAnswers: answerVariants(generated.answer),
			// Only ever shown *after* answering, which is what makes it safe:
			// `acceptedAnswers[0]` is the answer's own text, so this reading
			// annotates that string and nothing the learner still has to produce.
			...optionalString('answerRomanization', generated.answer.reading),
			...clozeWordBank(generated.answer, generated.distractorWords, rng),
			translationHint: generated.hintNative.trim()
		};
	}
} satisfies WireTypeDef<GeneratedCloze>;
