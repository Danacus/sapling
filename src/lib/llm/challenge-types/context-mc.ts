/**
 * `context-mc` — a target-language context is shown, the learner picks the
 * target text that fits it: the missing word in a sentence, or the fitting
 * reply to a line of dialogue. Stored as a `multiple-choice` challenge in the
 * `toTarget` direction, same as `produce-mc`.
 *
 * Unlike `produce-mc`, the prompt here is target-language too — the whole
 * challenge, context and options alike, is read in the language being
 * learned, with no native text anywhere to lean on. That is also what makes
 * it indistinguishable from `produce-mc` by `{type, direction}` alone: both
 * resolve to `{multiple-choice, toTarget}`, so this resolver marks the row
 * `promptIsTarget: true` — the one stored fact `kindOf` (`../requests`) reads
 * to tell the two apart, and the one the challenge component reads to know
 * the prompt carries a reading and a speaker button of its own.
 */

import { z } from 'zod';
import { assembleChoices, optionalString, readingOf } from '../resolve-helpers';
import { generatedBase, targetTextSchema, threeOf } from './primitives';
import type { WireTypeDef } from './def';

/** Target-language context shown, target text chosen. */
export const generatedContextMcSchema = z.object({
	type: z.literal('context-mc'),
	prompt: targetTextSchema,
	correct: targetTextSchema,
	distractors: threeOf(targetTextSchema),
	instruction: z.string().nullish(),
	...generatedBase
});

export type GeneratedContextMc = z.infer<typeof generatedContextMcSchema>;

/**
 * A one-word context could never pin down a reply or a missing word, so this
 * ladder starts where cloze's and spot-error's do rather than at a bare word.
 */
const CONTEXT_WORDS = [3, 5, 7, 9, 11] as const;

export const contextMcDef = {
	type: 'context-mc',
	schema: generatedContextMcSchema,
	stored: { type: 'multiple-choice', direction: 'toTarget', promptIsTarget: true },
	promptSpec:
		'context-mc — target-language context shown, target text picked. {prompt:TargetText, correct:TargetText, distractors:[3 TargetText], instruction} e.g. {"type":"context-mc","prompt":{"text":"Terminamos de comer y queremos pagar, así que le pedimos al camarero...","reading":null},"correct":{"text":"la cuenta","reading":null},"distractors":[{"text":"la carta","reading":null},{"text":"un café","reading":null},{"text":"la propina","reading":null}],"instruction":"Pick the word that fits","itemIds":["i2"],"explanation":null}',
	correctiveSpec: 'context-mc {prompt,correct,distractors: exactly 3}',
	paramsSpec:
		'- words: how many words the target-language context in "prompt" should have. A one-word context is not context.',
	params: (difficulty) => ({ words: CONTEXT_WORDS[difficulty - 1] }),
	rulesSpec:
		'- context-mc: "prompt" is a short target-language sentence or dialogue line with the fitting word or reply left for the learner to choose — never write the blank in, and never let native text appear anywhere in prompt, correct or distractors. Exactly one of the four options may fit the context; if two would both fit, rewrite the context. Distractors must be the same part of speech and plausible on their own, wrong only because the context rules them out.',

	fixtures: {
		spanish: [
			{
				order: 2.5,
				challenge: {
					type: 'context-mc',
					prompt: {
						text: 'Terminamos de comer y queremos pagar, así que le pedimos al camarero...',
						reading: null
					},
					correct: { text: 'la cuenta', reading: null },
					distractors: [
						{ text: 'la carta', reading: null },
						{ text: 'un café', reading: null },
						{ text: 'la propina', reading: null }
					],
					instruction: null,
					itemIds: ['la cuenta'],
					explanation: null
				}
			}
		],
		mandarin: [
			{
				order: 1.5,
				challenge: {
					type: 'context-mc',
					prompt: {
						text: '我们刚坐下，服务员问我们要不要先看一下',
						reading: 'Wǒmen gāng zuòxià, fúwùyuán wèn wǒmen yào bu yào xiān kàn yíxià'
					},
					correct: { text: '菜单', reading: 'càidān' },
					distractors: [
						{ text: '账单', reading: 'zhàngdān' },
						{ text: '筷子', reading: 'kuàizi' },
						{ text: '服务员', reading: 'fúwùyuán' }
					],
					instruction: null,
					itemIds: ['菜单'],
					explanation: null
				}
			}
		]
	},

	resolve(generated, { base, rng }) {
		return {
			...base,
			type: 'multiple-choice',
			direction: 'toTarget',
			promptIsTarget: true,
			prompt: generated.prompt.text.trim(),
			...optionalString('promptRomanization', generated.prompt.reading),
			...assembleChoices(
				[
					{
						text: generated.correct.text.trim(),
						reading: readingOf(generated.correct),
						correct: true
					},
					...generated.distractors.map((d) => ({
						text: d.text.trim(),
						reading: readingOf(d)
					}))
				],
				rng
			),
			...optionalString('instruction', generated.instruction)
		};
	}
} satisfies WireTypeDef<GeneratedContextMc>;
