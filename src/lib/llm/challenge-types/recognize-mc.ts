/**
 * `recognize-mc` — the target text is shown, the learner picks its native
 * meaning. Stored as a `multiple-choice` challenge in the `toNative` direction.
 *
 * The options are native-language meanings, so nothing here carries a reading:
 * an `optionsRomanization` column would have nothing to annotate.
 */

import { z } from 'zod';
import { assembleChoices, nativeSlotInTargetScript, optionalString } from '../resolve-helpers';
import { generatedBase, nonEmpty, targetTextSchema, threeOf } from './primitives';
import type { WireTypeDef } from './def';

/** Target text shown, native meaning chosen. */
export const generatedRecognizeMcSchema = z.object({
	type: z.literal('recognize-mc'),
	shown: targetTextSchema,
	correctMeaning: nonEmpty,
	distractors: threeOf(nonEmpty),
	/** Heading above the prompt; null when the UI's default heading fits. */
	instruction: z.string().nullish(),
	...generatedBase
});

export type GeneratedRecognizeMc = z.infer<typeof generatedRecognizeMcSchema>;

/**
 * How long the shown text runs at each rung: a bare word, a phrase, a clause, a
 * sentence, a long one. Measured on the same 1..12-word scale the stored side's
 * `lengthKnob` reads, so a challenge written at rung 1 lands near the bottom of
 * `multiple-choice`'s difficulty span and one written at rung 5 near the top.
 */
const SHOWN_WORDS = [1, 3, 5, 8, 11] as const;

export const recognizeMcDef = {
	type: 'recognize-mc',
	schema: generatedRecognizeMcSchema,
	stored: { type: 'multiple-choice', direction: 'toNative' },
	promptSpec:
		'recognize-mc — target text shown, native meaning picked. {shown:TargetText, correctMeaning, distractors:[3], instruction} e.g. {"type":"recognize-mc","shown":{"text":"el perro","reading":null},"correctMeaning":"the dog","distractors":["the cat","the bread","the house"],"instruction":null,"itemIds":["i1"],"explanation":null}',
	correctiveSpec: 'recognize-mc {shown,correctMeaning,distractors: exactly 3}',
	paramsSpec: '- words: how many words the target text in "shown" should have.',
	params: (difficulty) => ({ words: SHOWN_WORDS[difficulty - 1] }),
	rulesSpec:
		'- recognize-mc: exactly one of the four options may be correct given "shown"; if two would both answer it, rewrite it. The closer the distractors sit to correctMeaning without being a second right answer, the better the challenge.',

	fixtures: {
		spanish: [
			{
				order: 0,
				challenge: {
					type: 'recognize-mc',
					shown: { text: '¿Nos trae la cuenta, por favor?', reading: null },
					correctMeaning: 'Could you bring us the bill, please?',
					distractors: [
						'Could we see the menu, please?',
						'Is this table free?',
						'Could you bring another chair?'
					],
					// Exercises the instruction field: this is a dialogue turn, not a
					// bare vocabulary lookup, so the default "What does this mean?"
					// heading undersells it.
					instruction: 'What is the customer asking for?',
					itemIds: ['la cuenta'],
					explanation: 'Waiters are addressed with "usted", hence "trae" rather than "traes".'
				}
			}
		],
		mandarin: [
			{
				order: 0,
				challenge: {
					type: 'recognize-mc',
					shown: { text: '菜单', reading: 'càidān' },
					correctMeaning: 'the menu',
					distractors: ['the bill', 'the chopsticks', 'the waiter'],
					instruction: null,
					itemIds: ['菜单'],
					explanation: null
				}
			}
		]
	},

	resolve(generated, { base, rng }) {
		// Both sides in the target language is a structural failure, not a
		// cosmetic one: the "translation" being asked for is already shown.
		if (
			[generated.correctMeaning, ...generated.distractors].some((option) =>
				nativeSlotInTargetScript(option, generated.shown.text)
			)
		) {
			return null;
		}
		// The options are native-language meanings, so no reading rides along
		// and no `optionsRomanization` is produced.
		const { options: choices, correctIndex } = assembleChoices(
			[
				{ text: generated.correctMeaning.trim(), correct: true },
				...generated.distractors.map((text) => ({ text: text.trim() }))
			],
			rng
		);
		return {
			...base,
			type: 'multiple-choice',
			direction: 'toNative',
			prompt: generated.shown.text.trim(),
			...optionalString('promptRomanization', generated.shown.reading),
			options: choices,
			correctIndex,
			...optionalString('instruction', generated.instruction)
		};
	}
} satisfies WireTypeDef<GeneratedRecognizeMc>;
