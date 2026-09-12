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
	/**
	 * Always written: whether the learner *sees* it is a serve-time decision
	 * (`$lib/session/support`), since a row outlives the rung it was written at.
	 */
	hintNative: nonEmpty,
	/**
	 * Always five: every cloze now asks for the same word bank, and whether the
	 * learner ever sees it is a serve-time decision (`$lib/session/support`),
	 * not a generation-time one — there is no more "typed want" to tell this
	 * apart from. Nullish anyway, and not length-constrained on the wire: a
	 * reply that omits it (or sends the wrong count) is a cosmetic defect, not
	 * worth rejecting a challenge already paid for — the resolver stores
	 * whatever survives deduplication, null included, and a row with none is
	 * simply typed-only for life.
	 */
	distractorWords: z.array(targetTextSchema).nullish(),
	...generatedBase
});

export type GeneratedCloze = z.infer<typeof generatedClozeSchema>;

/** Sentence length at each rung, on the shared 1..12-word prose scale. */
const SENTENCE_WORDS = [3, 5, 7, 9, 11] as const;

export const clozeDef = {
	type: 'cloze',
	schema: generatedClozeSchema,
	stored: { type: 'cloze', direction: 'toTarget' },
	promptSpec:
		'cloze — one target-language word missing from a target-language sentence. {before:TargetText, answer:TargetText, after:TargetText, hintNative, distractorWords:[5 TargetText]} e.g. {"type":"cloze","before":{"text":"你好，请给我一份","reading":"Nǐ hǎo, qǐng gěi wǒ yī fèn"},"answer":{"text":"菜单","reading":"càidān"},"after":{"text":"。","reading":"."},"hintNative":"Hello, could I have a menu, please?","distractorWords":[{"text":"筷子","reading":"kuàizi"},{"text":"茶","reading":"chá"},{"text":"水","reading":"shuǐ"},{"text":"咖啡","reading":"kāfēi"},{"text":"啤酒","reading":"píjiǔ"}],"itemIds":["i3"],"explanation":"份 (fèn) is the measure word for a menu or a portion."} — before and after carry their own spacing and punctuation and the app puts the blank between them; either may be {"text":"","reading":null}. hintNative is the whole sentence in the native language; always include it. Always write exactly five distractorWords, plausible target-language words that do not fit the blank — whether the learner ever sees them is decided later, not by you.',
	rulesSpec:
		'- Cloze sentences use only vocabulary at or below the learner level. The target-language context and plausible target-language distractors must pin down the blank on their own: hintNative is always written but shown only to a learner still early with the word, so it is a bridge, never the sole clue.',
	correctiveSpec: 'cloze {before,answer,after,hintNative,distractorWords}',
	paramsSpec:
		'- words: how many words the whole sentence (before + answer + after) should have. Always write exactly five distractorWords too — that count no longer changes with the rung.',
	params: (difficulty) => ({
		words: SENTENCE_WORDS[difficulty - 1]
	}),

	// Two fixtures per scenario, kept deliberately: one with a word bank and one
	// without, so the resolver's two cloze shapes (chip-tap vs. typed) are both
	// exercised by a practice lesson — a reply that omits distractorWords is
	// rare but real, and the mock plays both.
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
						{ text: 'mesa', reading: null },
						{ text: 'servilleta', reading: null },
						{ text: 'botella', reading: null }
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
						{ text: '水', reading: 'shuǐ' },
						{ text: '咖啡', reading: 'kāfēi' },
						{ text: '啤酒', reading: 'píjiǔ' }
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
