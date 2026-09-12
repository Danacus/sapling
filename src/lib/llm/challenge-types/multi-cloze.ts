/**
 * `multi-cloze` — a short target-language passage with several gaps and one
 * shared word bank. The model writes the spans between gaps; the resolver owns
 * the markers, answer variants, bank order and item bindings.
 */

import { z } from 'zod';
import { answerVariants, labelKey, optionalString, readingOf, shuffled } from '../resolve-helpers';
import { clozePartSchema, generatedBase, itemRefSchema, targetTextSchema } from './primitives';
import type { TargetText } from './primitives';
import type { ResolveContext, WireTypeDef } from './def';

const generatedGapSchema = z.object({
	/** The known-item id or term this gap exercises. */
	itemId: itemRefSchema,
	answer: targetTextSchema
});

export const generatedMultiClozeSchema = z.object({
	type: z.literal('multi-cloze'),
	/** Consecutive target-language spans around the gaps; one more than `gaps`. */
	parts: z.array(clozePartSchema).min(3).max(5),
	gaps: z.array(generatedGapSchema).min(2).max(4),
	/**
	 * Wrong target-language choices only; answers enter the bank locally.
	 * Always written large enough that the shared bank reaches nine entries —
	 * answers included; how much of it a served challenge shows is a
	 * serve-time decision (`$lib/session/support`), not this schema's.
	 */
	distractorWords: z.array(targetTextSchema).min(2),
	...generatedBase
});

export type GeneratedMultiCloze = z.infer<typeof generatedMultiClozeSchema>;

const PASSAGE_WORDS = [8, 11, 14, 17, 20] as const;
const GAP_COUNTS = [2, 2, 3, 3, 4] as const;

/**
 * The shared bank's target size, answers included — constant, not a ladder:
 * which rung a word sits at no longer changes what is *written*, only what a
 * served challenge *shows* (`$lib/session/support`'s
 * `bankSizeFor`/`visibleBank`). Nine is the top of the old ladder, so every
 * banked passage is written with the fullest bank the model can supply.
 */
const BANK_ENTRIES = 9;

function marker(index: number): string {
	return `___${index + 1}___`;
}

function passageRomanization(
	parts: readonly { text: string; reading?: string | null }[],
	gaps: readonly { answer: TargetText }[]
): string | undefined {
	if (gaps.some((gap) => !readingOf(gap.answer))) return undefined;
	if (parts.some((part) => part.text.trim() && !readingOf(part))) return undefined;
	return (
		parts
			.flatMap((part, index) => [readingOf(part) ?? '', ...(index < gaps.length ? ['___'] : [])])
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim() || undefined
	);
}

/**
 * Shared word bank; every answer survives and collision-prone extras do not.
 * Stores the full surviving set — sizing how much of it a served challenge
 * shows is `$lib/session/support`'s job, not this resolver's.
 */
function wordBank(
	gaps: readonly { answer: TargetText }[],
	distractors: readonly TargetText[],
	rng: () => number
): { wordBank: string[]; wordBankRomanization?: string[] } | null {
	const answers = gaps.map((gap) => ({
		text: gap.answer.text.trim(),
		reading: readingOf(gap.answer)
	}));
	const answerKeys = answers.map((answer) => labelKey(answer.text));
	// Each physical chip can be placed only once, so two gaps may not silently
	// rely on the same bank entry.
	if (answerKeys.some((key) => !key) || new Set(answerKeys).size !== answerKeys.length) return null;

	const entries = [...answers];
	const seen = new Set(answerKeys);
	for (const distractor of distractors) {
		const text = distractor.text.trim();
		const key = labelKey(text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		entries.push({ text, reading: readingOf(distractor) });
	}

	// A shared bank needs at least two plausible alternatives beyond the answers.
	if (entries.length < answers.length + 2) return null;
	const shuffledEntries = shuffled(entries, rng);
	const readings = shuffledEntries.map((entry) => entry.reading);
	return {
		wordBank: shuffledEntries.map((entry) => entry.text),
		...(readings.every((reading): reading is string => !!reading)
			? { wordBankRomanization: readings }
			: {})
	};
}

function itemIdFor(
	ref: string,
	index: number,
	generated: GeneratedMultiCloze,
	ctx: ResolveContext
): string | undefined {
	const resolved = ctx.resolveItemRef?.(ref);
	if (resolved) return resolved;
	// A bare def resolve in a fixture has no term index. The normal pipeline
	// supplies `resolveItemRef`; this fallback keeps isolated fixture resolution
	// useful while preserving the generated item's order where it can.
	const sourceIndex = generated.itemIds.indexOf(ref);
	return ctx.base.itemIds[sourceIndex >= 0 ? sourceIndex : index] ?? ctx.base.itemIds[0];
}

export const multiClozeDef = {
	type: 'multi-cloze',
	schema: generatedMultiClozeSchema,
	stored: { type: 'multi-cloze', direction: 'toTarget' },
	promptSpec: `multi-cloze — 2-4 target-language sentences with 2-4 target-language gaps and one shared bank of ${BANK_ENTRIES}. {parts:[{text,reading}],gaps:[{itemId,answer:{text,reading}}],distractorWords:[{text,reading}],itemIds} e.g. {"type":"multi-cloze","parts":[{"text":"En el restaurante, pido ","reading":null},{"text":". Después pago la ","reading":null},{"text":".","reading":null}],"gaps":[{"itemId":"pedir","answer":{"text":"comida","reading":null}},{"itemId":"la cuenta","answer":{"text":"cuenta","reading":null}}],"distractorWords":[{"text":"mesa","reading":null},{"text":"carta","reading":null},{"text":"propina","reading":null},{"text":"botella","reading":null},{"text":"servilleta","reading":null},{"text":"copa","reading":null},{"text":"plato","reading":null}],"itemIds":["pedir","la cuenta"],"explanation":null} — parts are consecutive spans around gaps and must have exactly one more entry than gaps; gaps and itemIds are in the same order; all text is target-language. Write enough distractorWords that, together with the answers, the shared bank has ${BANK_ENTRIES} entries.`,
	rulesSpec:
		'- Multi-cloze is target-language-only: do not include a native translation or hint. Write a coherent 2-4 sentence scene, use each itemId for exactly one gap, and make distractors plausible in the same context without making an answer ambiguous.',
	correctiveSpec: 'multi-cloze {parts,gaps,distractorWords,itemIds}',
	paramsSpec: '- words: target-language words across the whole passage. gaps: blanks to write.',
	params: (difficulty) => ({
		words: PASSAGE_WORDS[difficulty - 1],
		gaps: GAP_COUNTS[difficulty - 1]
	}),
	escalationSpec:
		'multi-cloze passage stores numbered gaps; the logged answer is `N: chosen word` entries in passage order, and each gap has its own accepted answer and item id.',
	fixtures: {
		spanish: [
			{
				order: 8,
				challenge: {
					type: 'multi-cloze',
					parts: [
						{ text: 'Primero queremos ', reading: null },
						{ text: '. Después pedimos la ', reading: null },
						{ text: ' para pagar.', reading: null }
					],
					gaps: [
						{ itemId: 'pedir', answer: { text: 'pedir', reading: null } },
						{ itemId: 'la cuenta', answer: { text: 'cuenta', reading: null } }
					],
					distractorWords: [
						{ text: 'mesa', reading: null },
						{ text: 'carta', reading: null },
						{ text: 'propina', reading: null },
						{ text: 'botella', reading: null },
						{ text: 'servilleta', reading: null },
						{ text: 'copa', reading: null },
						{ text: 'plato', reading: null }
					],
					itemIds: ['pedir', 'la cuenta'],
					explanation: null
				}
			}
		],
		mandarin: [
			{
				order: 8,
				challenge: {
					type: 'multi-cloze',
					parts: [
						{ text: '我们先看', reading: 'Wǒmen xiān kàn' },
						{ text: '，然后想', reading: 'ránhòu xiǎng' },
						{ text: '。', reading: '。' }
					],
					gaps: [
						{ itemId: '菜单', answer: { text: '菜单', reading: 'càidān' } },
						{ itemId: '买单', answer: { text: '买单', reading: 'mǎidān' } }
					],
					distractorWords: [
						{ text: '筷子', reading: 'kuàizi' },
						{ text: '茶', reading: 'chá' },
						{ text: '水', reading: 'shuǐ' },
						{ text: '咖啡', reading: 'kāfēi' },
						{ text: '啤酒', reading: 'píjiǔ' },
						{ text: '碗', reading: 'wǎn' },
						{ text: '勺子', reading: 'sháozi' }
					],
					itemIds: ['菜单', '买单'],
					explanation: '先 (xiān) marks the first action; 然后 (ránhòu) introduces what comes next.'
				}
			}
		]
	},

	resolve(generated, ctx) {
		if (generated.parts.length !== generated.gaps.length + 1) return null;
		const resolvedItemIds = generated.gaps.map((gap, index) =>
			itemIdFor(gap.itemId, index, generated, ctx)
		);
		if (!resolvedItemIds.every((itemId): itemId is string => typeof itemId === 'string')) {
			return null;
		}
		// The production resolver maps each cited term/id. Fixture tests invoke a
		// def in isolation with one synthetic base id, where a meaningful distinct
		// binding cannot exist; preserve that narrow fixture convenience only there.
		if (ctx.resolveItemRef && new Set(resolvedItemIds).size !== resolvedItemIds.length) return null;
		const itemIds = resolvedItemIds;

		const bank = wordBank(generated.gaps, generated.distractorWords, ctx.rng);
		if (!bank) return null;

		const passage = generated.parts
			.map((part, index) => `${part.text}${index < generated.gaps.length ? marker(index) : ''}`)
			.join('');
		const romanization = passageRomanization(generated.parts, generated.gaps);

		return {
			...ctx.base,
			type: 'multi-cloze',
			direction: 'toTarget',
			passage,
			...optionalString('passageRomanization', romanization),
			gaps: generated.gaps.map((gap, index) => ({
				itemId: itemIds[index]!,
				acceptedAnswers: answerVariants(gap.answer),
				...optionalString('answerRomanization', gap.answer.reading)
			})),
			...bank,
			itemIds
		};
	}
} satisfies WireTypeDef<GeneratedMultiCloze>;
