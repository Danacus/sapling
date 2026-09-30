/**
 * Lesson generation and escalation through the wasm build's `llm` export, in
 * mock mode (node has no key): the Rust fixtures through the Rust resolvers.
 * That every kind resolves to a well-formed stored challenge of its demand is
 * checked on the Rust side (`sapling-llm`'s `lesson.rs`).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { Presentation } from '$lib/challenges/serve';
import { ALL_READINGS } from '$lib/challenges/serve';
import { loadWasmCore } from '$lib/db/backend.testing';
import type { ClozeChallenge, WordOrderChallenge } from '$lib/types';
import { describeShown, getBatch, getEscalation, isMockMode } from './index';
import type { BatchArgs, ProgressStep, Want, WireType } from './index';

beforeAll(loadWasmCore);

/** Every kind in registry order, and the stored `type` each resolves to. */
const ALL_KINDS: [WireType, string][] = [
	['recognize-mc', 'multiple-choice'],
	['produce-mc', 'multiple-choice'],
	['context-mc', 'multiple-choice'],
	['translate-to-native', 'typed-translation'],
	['spot-error', 'spot-error'],
	['word-order', 'word-order'],
	['cloze', 'cloze'],
	['multi-cloze', 'multi-cloze'],
	['translate-to-target', 'typed-translation']
];

function batch(
	targetLanguage: string,
	kinds: WireType[] = ALL_KINDS.map(([kind]) => kind)
): BatchArgs {
	const wants: Want[] = kinds.map((type) => ({
		item: { id: 'w1', term: 'la cuenta', meaning: 'the bill' },
		kind: { type },
		difficulty: 3
	}));
	return {
		profile: { nativeLanguage: 'English', targetLanguage, level: 'beginner', interests: [] },
		wants,
		knownItems: [
			{ id: 'w1', term: 'la cuenta' },
			{ id: 'w2', term: 'pedir' }
		]
	};
}

describe('getBatch', () => {
	it('runs in mock mode under node', () => {
		expect(isMockMode()).toBe(true);
	});

	for (const target of ['Spanish', 'Chinese']) {
		it(`writes one stored challenge per want, of the kind asked (${target})`, async () => {
			const result = await getBatch(batch(target));
			expect(result.challenges.map((c) => c.type)).toEqual(ALL_KINDS.map(([, type]) => type));
			for (const challenge of result.challenges) {
				expect(challenge.itemIds).toContain('w1');
			}
			expect(result.failedRequests).toBe(0);
		});
	}

	it('reads a reading off every Mandarin fixture that has one to give', async () => {
		const { challenges } = await getBatch(batch('Chinese', ['cloze', 'word-order']));
		const [cloze, wordOrder] = challenges as [ClozeChallenge, WordOrderChallenge];
		expect(cloze.sentenceRomanization).toBeTruthy();
		expect(cloze.acceptedAnswers.length).toBeGreaterThan(1);
		expect(wordOrder.tilesRomanization?.length).toBe(wordOrder.tiles.length);
	});

	it('reports its steps and passes the request knobs through', async () => {
		const steps: ProgressStep[] = [];
		await getBatch(batch('Spanish', ['cloze', 'cloze']), {
			onProgress: (step) => steps.push(step),
			itemsPerRequest: 1,
			reasoningEffort: 'low'
		});
		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
		expect(steps[1].label).toBe('Waiting for practice-mode content');
	});

	it('rejects an empty brief as an LlmError', async () => {
		await expect(getBatch({ ...batch('Spanish'), wants: [] })).rejects.toMatchObject({
			kind: 'bad-response'
		});
	});
});

describe('getEscalation', () => {
	const presentation = (fields: Partial<Presentation>): Presentation => ({
		showHint: true,
		bankSize: 0,
		distractorTiles: 0,
		readings: ALL_READINGS,
		listening: false,
		shown: 'plain',
		...fields
	});

	it('reports only what the served presentation showed', () => {
		const cloze: ClozeChallenge = {
			id: 'c',
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Nos trae la ___, por favor?',
			acceptedAnswers: ['cuenta'],
			wordBank: ['cuenta', 'carta', 'propina', 'mesa'],
			itemIds: ['i']
		};
		expect(describeShown(cloze, presentation({ bankSize: 2, showHint: false }))).toEqual({
			nativeLine: false,
			wordBank: ['cuenta', 'carta']
		});
		expect(describeShown(cloze).wordBank).toHaveLength(4);
	});

	it('answers from the mock and never overturns', async () => {
		const reply = await getEscalation({
			challenge: {
				id: 'c',
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'the bill',
				acceptedAnswers: ['la cuenta'],
				itemIds: ['i']
			},
			answerGiven: 'el cuenta',
			verdict: 'wrong',
			nativeLanguage: 'English',
			targetLanguage: 'Spanish'
		});
		expect(reply.overturn).toBe(false);
		expect(reply.answer).toContain('"el cuenta" was graded "wrong"');
	});
});
