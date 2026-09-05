/**
 * `translate-to-target` — a native prompt, typed back in the target language.
 * Stored as a `typed-translation` in the `toTarget` direction.
 *
 * The model's job is exhaustiveness: every genuinely different phrasing, one
 * per entry. Accent- and tone-stripped spellings are *not* asked for — they are
 * derived here from each answer's reading, which is why the prompt forbids
 * spending tokens on them.
 */

import { z } from 'zod';
import { answerVariants, dedupe, optionalString } from '../resolve-helpers';
import { generatedBase, nonEmpty, targetTextSchema } from './primitives';
import type { WireTypeDef } from './def';

/** Type the target language. Multiple `answers` are genuinely different phrasings. */
export const generatedTranslateToTargetSchema = z.object({
	type: z.literal('translate-to-target'),
	promptNative: nonEmpty,
	answers: z.array(targetTextSchema).min(1),
	...generatedBase
});

export type GeneratedTranslateToTarget = z.infer<typeof generatedTranslateToTargetSchema>;

/** Mirror of `translate-to-native`'s ladder, read off the native prompt. */
const PROMPT_WORDS = [2, 4, 6, 8, 11] as const;

export const translateToTargetDef = {
	type: 'translate-to-target',
	schema: generatedTranslateToTargetSchema,
	stored: { type: 'typed-translation', direction: 'toTarget' },
	promptSpec:
		'translate-to-target — type the target language. {promptNative, answers:[TargetText, 1 or more]} e.g. {"type":"translate-to-target","promptNative":"Excuse me, the bill please.","answers":[{"text":"服务员，买单","reading":"fúwùyuán, mǎidān"},{"text":"买单","reading":"mǎidān"}],"itemIds":["i4"],"explanation":null}',
	rulesSpec:
		'- translate-to-target answers must be exhaustive, one entry per genuinely different way to say it: with and without the article, contractions, common synonyms and word orders. Do NOT list tone- or accent-stripped spellings — the app derives those from "reading".',
	correctiveSpec: 'translate-to-target {promptNative,answers}',
	paramsSpec: '- words: how many words the native prompt in "promptNative" should have.',
	params: (difficulty) => ({ words: PROMPT_WORDS[difficulty - 1] }),

	fixtures: {
		spanish: [
			{
				order: 3,
				challenge: {
					type: 'translate-to-target',
					promptNative: 'I would like to order the fish, please.',
					answers: [
						{ text: 'quisiera pedir el pescado, por favor', reading: null },
						{ text: 'quiero pedir el pescado, por favor', reading: null }
					],
					itemIds: ['pedir'],
					explanation: '"Quisiera" is the polite way to ask; "quiero" is fine but blunter.'
				}
			}
		],
		mandarin: [
			{
				order: 3,
				challenge: {
					type: 'translate-to-target',
					promptNative: 'Excuse me, the bill please.',
					answers: [
						{ text: '服务员，买单', reading: 'fúwùyuán, mǎidān' },
						{ text: '买单', reading: 'mǎidān' }
					],
					itemIds: ['买单'],
					explanation: 'Calling 服务员 (fúwùyuán) across the room is normal, not rude.'
				}
			}
		]
	},

	resolve(generated, { base }) {
		return {
			...base,
			type: 'typed-translation',
			direction: 'toTarget',
			// No `promptRomanization`: the prompt is native, and the field does
			// not exist on this wire type, so the answer's reading has nowhere
			// to leak to.
			prompt: generated.promptNative.trim(),
			acceptedAnswers: dedupe(generated.answers.flatMap(answerVariants)),
			// The first answer is the canonical one (`answerVariants` puts its
			// text first), so its reading is the one that belongs under the
			// answer the banner shows.
			...optionalString('answerRomanization', generated.answers[0].reading)
		};
	}
} satisfies WireTypeDef<GeneratedTranslateToTarget>;
