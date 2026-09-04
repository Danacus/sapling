/**
 * `spot-error` — one wrong word planted in a target sentence, for the learner
 * to tap.
 *
 * The model hands over the **correct** sentence plus a description of the
 * corruption (`wrongWord` at `wrongPosition`); the swap happens here. So the
 * model never hands over a sentence with the answer already baked into it, the
 * position of the error is a fact the app derives rather than one it trusts, and
 * the corrected sentence the banner shows is the model's own line, untouched.
 */

import { z } from 'zod';
import { joinTokens } from '$lib/text';
import { labelKey, readingOf, tokenReadings, tokenize } from '../resolve-helpers';
import type { Token } from '../resolve-helpers';
import { generatedBase, nonEmpty, targetTextSchema } from './primitives';
import type { WireTypeDef } from './def';

export const generatedSpotErrorSchema = z.object({
	type: z.literal('spot-error'),
	/** The **correct** sentence, segmented; the corruption is applied locally. */
	words: z.array(targetTextSchema).min(3),
	wrongWord: targetTextSchema,
	/** 0-based index into `words`; the resolver rejects one that overshoots. */
	wrongPosition: z.int().min(0),
	/** What the sentence is meant to say — what makes the error findable. */
	meaningNative: nonEmpty,
	...generatedBase
});

export type GeneratedSpotError = z.infer<typeof generatedSpotErrorSchema>;

export const spotErrorDef = {
	type: 'spot-error',
	schema: generatedSpotErrorSchema,
	stored: { type: 'spot-error', direction: 'toNative' },
	promptSpec:
		'spot-error — one wrong word in a target sentence. {words:[3+ TargetText — the CORRECT sentence split into tiles, in order], wrongWord:TargetText, wrongPosition:int, meaningNative} e.g. {"type":"spot-error","words":[{"text":"我们","reading":"wǒmen"},{"text":"想","reading":"xiǎng"},{"text":"买单","reading":"mǎidān"}],"wrongWord":{"text":"菜单","reading":"càidān"},"wrongPosition":2,"meaningNative":"We would like to pay the bill.","itemIds":["i7"],"explanation":null} — the app replaces words[wrongPosition] with wrongWord and asks the learner to tap it.',
	rulesSpec:
		'- spot-error: wrongWord must be a real target-language word that is unambiguously wrong in that slot given meaningNative — same part of speech, wrong meaning — never a synonym, a spelling slip or a stylistic quibble. wrongPosition is a 0-based index into words, and wrongWord must differ from the word it replaces. Difficulty scales sentence length and how subtle the swap is — obvious at 1, subtle at 5.',
	correctiveSpec: 'spot-error {words,wrongWord,wrongPosition,meaningNative}',
	escalationSpec:
		'"spot-error": "tokens" is the sentence as the learner saw it, "correctIndex" is the position of the WRONG word they had to tap, "intendedWord" is what belongs there and "meaning" is what the sentence was supposed to say.',

	fixtures: {
		spanish: [
			{
				order: 7,
				challenge: {
					type: 'spot-error',
					words: [
						{ text: 'Quisiera', reading: null },
						{ text: 'pedir', reading: null },
						{ text: 'el', reading: null },
						{ text: 'pescado.', reading: null }
					],
					wrongWord: { text: 'pagar', reading: null },
					wrongPosition: 1,
					meaningNative: 'I would like to order the fish.',
					itemIds: ['pedir'],
					explanation: '"Pagar" is to pay; ordering is "pedir".'
				}
			}
		],
		mandarin: [
			{
				order: 7,
				challenge: {
					type: 'spot-error',
					words: [
						{ text: '我们', reading: 'wǒmen' },
						{ text: '想', reading: 'xiǎng' },
						{ text: '买单', reading: 'mǎidān' }
					],
					wrongWord: { text: '菜单', reading: 'càidān' },
					wrongPosition: 2,
					meaningNative: 'We would like to pay the bill.',
					itemIds: ['买单'],
					explanation: '菜单 (càidān) is the menu; paying the bill is 买单 (mǎidān).'
				}
			}
		]
	},

	resolve(generated, { base }) {
		const words = tokenize(generated.words);
		const wrong: Token = {
			text: generated.wrongWord.text.trim(),
			reading: readingOf(generated.wrongWord)
		};
		const at = generated.wrongPosition;
		// All structural: a corruption that lands outside the sentence, or one
		// that replaces a word with itself, leaves nothing to find. There is no
		// cosmetic reading of either — the challenge would be unanswerable.
		if (!words || words.length < 3 || at >= words.length || !wrong.text) return null;
		if (labelKey(wrong.text) === labelKey(words[at].text)) return null;

		const tokens = words.map((word, index) => (index === at ? wrong : word));

		return {
			...base,
			type: 'spot-error',
			// The sentence is target-language and the meaning is given; the
			// learner is reading *out* of the target language to find the slip.
			direction: 'toNative',
			tokens: tokens.map((token) => token.text),
			...tokenReadings('tokensRomanization', tokens),
			correctIndex: at,
			intendedWord: words[at].text,
			...(words[at].reading ? { intendedWordRomanization: words[at].reading } : {}),
			correctedSentence: joinTokens(words.map((word) => word.text)),
			meaning: generated.meaningNative.trim()
		};
	}
} satisfies WireTypeDef<GeneratedSpotError>;
