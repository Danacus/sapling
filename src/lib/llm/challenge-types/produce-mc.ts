/**
 * `produce-mc` — a native prompt is shown, the learner picks the target text.
 * Stored as a `multiple-choice` challenge in the `toTarget` direction.
 *
 * Mirror image of `recognize-mc`: here the *options* are target language, so
 * each carries its own reading through the shuffle and the column survives
 * intact — while the prompt is native by construction and has no reading that
 * could spoil the answer.
 */

import { z } from 'zod';
import {
	assembleChoices,
	nativeSlotInTargetScript,
	optionalString,
	readingOf
} from '../resolve-helpers';
import { generatedBase, nonEmpty, targetTextSchema, threeOf } from './primitives';
import type { WireTypeDef } from './def';

/** Native prompt shown, target text chosen. */
export const generatedProduceMcSchema = z.object({
	type: z.literal('produce-mc'),
	promptNative: nonEmpty,
	correct: targetTextSchema,
	distractors: threeOf(targetTextSchema),
	instruction: z.string().nullish(),
	...generatedBase
});

export type GeneratedProduceMc = z.infer<typeof generatedProduceMcSchema>;

/** Mirror of `recognize-mc`'s ladder, read off the native prompt instead. */
const PROMPT_WORDS = [1, 3, 5, 8, 11] as const;

export const produceMcDef = {
	type: 'produce-mc',
	schema: generatedProduceMcSchema,
	stored: { type: 'multiple-choice', direction: 'toTarget' },
	promptSpec:
		'produce-mc — native prompt shown, target text picked. {promptNative, correct:TargetText, distractors:[3 TargetText], instruction} e.g. {"type":"produce-mc","promptNative":"to order (food in a restaurant)","correct":{"text":"pedir","reading":null},"distractors":[{"text":"pagar","reading":null},{"text":"probar","reading":null},{"text":"servir","reading":null}],"instruction":null,"itemIds":["i2"],"explanation":null}',
	correctiveSpec: 'produce-mc {promptNative,correct,distractors: exactly 3}',
	paramsSpec: '- words: how many words the native prompt in "promptNative" should have.',
	params: (difficulty) => ({ words: PROMPT_WORDS[difficulty - 1] }),
	rulesSpec:
		'- produce-mc: exactly one of the four options may answer promptNative; if two would both do, rewrite the prompt. The closer the distractors sit to the correct target text without being a second right answer, the better the challenge.',

	fixtures: {
		spanish: [
			{
				order: 2,
				challenge: {
					type: 'produce-mc',
					promptNative: 'to order (food in a restaurant)',
					correct: { text: 'pedir', reading: null },
					distractors: [
						{ text: 'pagar', reading: null },
						{ text: 'probar', reading: null },
						{ text: 'servir', reading: null }
					],
					instruction: null,
					itemIds: ['pedir'],
					explanation: null
				}
			}
		],
		mandarin: [
			{
				order: 1,
				challenge: {
					type: 'produce-mc',
					promptNative: 'Could I see the menu?',
					correct: { text: '菜单', reading: 'càidān' },
					distractors: [
						{ text: '筷子', reading: 'kuàizi' },
						{ text: '服务员', reading: 'fúwùyuán' },
						{ text: '茶', reading: 'chá' }
					],
					instruction: null,
					itemIds: ['菜单'],
					explanation: null
				}
			}
		]
	},

	resolve(generated, { base, rng }) {
		if (nativeSlotInTargetScript(generated.promptNative, generated.correct.text)) {
			return null;
		}
		return {
			...base,
			type: 'multiple-choice',
			direction: 'toTarget',
			// The prompt is native by construction, so there is no reading to
			// show and none to accidentally spoil the answer with.
			prompt: generated.promptNative.trim(),
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
} satisfies WireTypeDef<GeneratedProduceMc>;
