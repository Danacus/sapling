/**
 * `translate-to-native` — a target-language prompt, typed back in the native
 * language. Stored as a `typed-translation` in the `toNative` direction.
 *
 * The prompt keeps its reading: it is the side the learner is reading *out* of,
 * and the answer lives in another language entirely, so no romanization here can
 * give it away.
 */

import { z } from 'zod';
import { dedupe, nativeSlotInTargetScript, optionalString } from '../resolve-helpers';
import { generatedBase, nonEmpty, targetTextSchema } from './primitives';
import type { WireTypeDef } from './def';

/** Type the native language. */
export const generatedTranslateToNativeSchema = z.object({
	type: z.literal('translate-to-native'),
	prompt: targetTextSchema,
	answersNative: z.array(nonEmpty).min(1),
	...generatedBase
});

export type GeneratedTranslateToNative = z.infer<typeof generatedTranslateToNativeSchema>;

export const translateToNativeDef = {
	type: 'translate-to-native',
	schema: generatedTranslateToNativeSchema,
	promptSpec:
		'translate-to-native — type the native language. {prompt:TargetText, answersNative:[1 or more]} e.g. {"type":"translate-to-native","prompt":{"text":"la cuenta","reading":null},"answersNative":["the bill","the check"],"itemIds":["i5"],"explanation":null}',
	correctiveSpec: 'translate-to-native {prompt,answersNative}',
	rulesSpec: "- translate-to-native: difficulty scales prompt's length in words, 1 shortest.",

	fixtures: {
		spanish: [
			{
				order: 5,
				challenge: {
					type: 'translate-to-native',
					prompt: { text: 'la cuenta', reading: null },
					answersNative: ['the bill', 'the check'],
					itemIds: ['la cuenta'],
					explanation: null
				}
			}
		],
		mandarin: [
			{
				order: 5,
				challenge: {
					type: 'translate-to-native',
					prompt: { text: '买单', reading: 'mǎidān' },
					answersNative: ['to pay the bill', 'pay the bill'],
					itemIds: ['买单'],
					explanation: null
				}
			}
		]
	},

	resolve(generated, { base }) {
		// An accepted "native" answer in the target's own script grades
		// copying the prompt as correct — the same both-sides failure the two
		// multiple-choice defs guard against.
		if (
			generated.answersNative.some((answer) =>
				nativeSlotInTargetScript(answer, generated.prompt.text)
			)
		) {
			return null;
		}
		return {
			...base,
			type: 'typed-translation',
			direction: 'toNative',
			prompt: generated.prompt.text.trim(),
			...optionalString('promptRomanization', generated.prompt.reading),
			acceptedAnswers: dedupe(generated.answersNative)
		};
	}
} satisfies WireTypeDef<GeneratedTranslateToNative>;
