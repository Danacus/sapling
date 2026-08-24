/**
 * `word-order` — a target sentence built back out of shuffled tiles.
 *
 * The model segments and the app shuffles, so there is no `correctOrder` field
 * to disagree with the sentence: the answer *is* the array's own order. That
 * split is what makes the type work for Chinese and Japanese — word boundaries
 * are a language question the model can answer and a local tokenizer cannot.
 *
 * Two ceilings guard the tray — see {@link MAX_WORD_ORDER_DISTRACTORS} and
 * {@link MAX_WORD_ORDER_TILES} — because a tray twice the size of the sentence
 * stops being a word-order exercise and becomes a search.
 */

import { z } from 'zod';
import { isPunctuationOnly, joinTokens, mergePunctuationTokens } from '$lib/text';
import {
	MAX_WORD_ORDER_DISTRACTORS,
	MAX_WORD_ORDER_TILES,
	labelKey,
	optionalString,
	readingOf,
	shuffled,
	tokenReadings,
	tokenize
} from '../resolve-helpers';
import type { Token } from '../resolve-helpers';
import { generatedBase, nonEmpty, targetTextSchema } from './primitives';
import type { WireTypeDef } from './def';

export const generatedWordOrderSchema = z.object({
	type: z.literal('word-order'),
	promptNative: nonEmpty,
	/** The sentence *in the correct order*; the app shuffles. */
	words: z.array(targetTextSchema).min(2),
	/**
	 * Extra wrong tiles. Not length-constrained, for the same reason as the
	 * cloze word bank: an oversized list is a cosmetic defect and the resolver
	 * caps it rather than costing us a challenge we already paid for.
	 */
	distractorWords: z.array(targetTextSchema).nullish(),
	instruction: z.string().nullish(),
	...generatedBase
});

export type GeneratedWordOrder = z.infer<typeof generatedWordOrderSchema>;

export const wordOrderDef = {
	type: 'word-order',
	schema: generatedWordOrderSchema,
	promptSpec: 'word-order — build a target sentence out of tiles. {promptNative, words:[2+ TargetText — the sentence split into tiles, IN THE CORRECT ORDER], distractorWords:[0-3 TargetText] or null, instruction} e.g. {"type":"word-order","promptNative":"Could you bring us the bill, please?","words":[{"text":"¿Nos","reading":null},{"text":"trae","reading":null},{"text":"la","reading":null},{"text":"cuenta,","reading":null},{"text":"por","reading":null},{"text":"favor?","reading":null}],"distractorWords":[{"text":"carta","reading":null}],"instruction":null,"itemIds":["i6"],"explanation":null} — the app shuffles the tiles, so never state an order anywhere else.',
	rulesSpec: '- word-order sentences must have exactly one natural order: if the same tiles could be rearranged into a second correct sentence, rewrite it. Keep them to 4-8 tiles — 8 is a hard limit; past it, shorten the sentence. distractorWords are plausible words that fit nowhere in the sentence, never a form of a word already in it.',
	correctiveSpec: 'word-order {promptNative,words}',
	escalationSpec: '"word-order": the learner arranged the shuffled "tiles" into a sentence, and "answerTokens" in that order (printed as "answer") is the only accepted arrangement.',

	fixtures: {
		spanish: [
			{
				order: 6,
				challenge: {
					type: 'word-order',
					promptNative: 'Could you bring us the bill, please?',
					words: [
						{ text: '¿Nos', reading: null },
						{ text: 'trae', reading: null },
						{ text: 'la', reading: null },
						{ text: 'cuenta,', reading: null },
						{ text: 'por', reading: null },
						{ text: 'favor?', reading: null }
					],
					distractorWords: [
						{ text: 'carta', reading: null },
						{ text: 'propina', reading: null }
					],
					instruction: null,
					itemIds: ['new:0'],
					explanation: null
				}
			}
		],
		mandarin: [
			{
				order: 6,
				challenge: {
					// Segmented per *word*, not per character — 菜单 is one tile. That is
					// the whole reason the model does the splitting. Punctuation rides
					// the word it touches, never a tile of its own, per the prompt rule.
					type: 'word-order',
					promptNative: 'Hello, could I have a menu, please?',
					words: [
						{ text: '你好，', reading: 'nǐ hǎo' },
						{ text: '请', reading: 'qǐng' },
						{ text: '给', reading: 'gěi' },
						{ text: '我', reading: 'wǒ' },
						{ text: '菜单。', reading: 'càidān' }
					],
					distractorWords: [
						{ text: '筷子', reading: 'kuàizi' },
						{ text: '茶', reading: 'chá' }
					],
					instruction: null,
					itemIds: ['new:0'],
					explanation: null
				}
			}
		]
	},

	resolve(generated, { base, rng }) {
		// Structural: fewer than two real tiles is not a sentence to build,
		// and a blank tile is a tile that cannot be tapped. Punctuation-only
		// tiles ("？" as its own tile) are merged into their neighbour first —
		// forgetting a question mark is not a language mistake, so it must
		// not be a placeable, gradeable tile.
		const raw = tokenize(generated.words);
		const words = raw && mergePunctuationTokens(raw);
		if (!words || words.length < 2) return null;

		// Distractors are cosmetic: an oversized list is trimmed, and one that
		// duplicates a real tile is dropped — it could only ever be used in
		// place of its twin, which grades correct anyway (text sequence, not
		// indices), so it is a tile that does nothing. The allowance shrinks
		// as the sentence grows, so an overshot sentence is not padded past
		// MAX_WORD_ORDER_TILES into a search puzzle.
		const allowance = Math.min(
			MAX_WORD_ORDER_DISTRACTORS,
			Math.max(0, MAX_WORD_ORDER_TILES - words.length)
		);
		const seen = new Set(words.map((word) => labelKey(word.text)));
		const distractors: Token[] = [];
		for (const candidate of generated.distractorWords ?? []) {
			if (distractors.length >= allowance) break;
			const token = { text: candidate.text.trim(), reading: readingOf(candidate) };
			const key = labelKey(token.text);
			if (!key || seen.has(key) || isPunctuationOnly(token.text)) continue;
			seen.add(key);
			distractors.push(token);
		}

		const tiles = shuffled([...words, ...distractors], rng);
		const answerTokens = words.map((word) => word.text);
		const answerReadings = words.map((word) => word.reading);

		return {
			...base,
			type: 'word-order',
			direction: 'toTarget',
			// Native by construction: there is no reading to leak the sentence.
			prompt: generated.promptNative.trim(),
			tiles: tiles.map((tile) => tile.text),
			...tokenReadings('tilesRomanization', tiles),
			answerTokens,
			// The script decides the spacing, once, here — so the sentence the
			// banner prints is byte-identical to the one the component assembles
			// out of the learner's tiles.
			answer: joinTokens(answerTokens),
			...(answerReadings.every((reading): reading is string => !!reading)
				? { answerRomanization: answerReadings.join(' ') }
				: {}),
			...optionalString('instruction', generated.instruction)
		};
	}
} satisfies WireTypeDef<GeneratedWordOrder>;
