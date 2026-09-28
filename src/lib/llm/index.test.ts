/**
 * Lesson generation and escalation through the wasm build's `llm` export, in
 * mock mode (node has no key): the Rust fixtures through the Rust resolvers,
 * checked against the stored union the rest of the app reads.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { demandOf } from '$lib/challenges/demand';
import type { Presentation } from '$lib/challenges/serve/presentation';
import { ALL_READINGS } from '$lib/challenges/serve/reading';
import { challengeSchema } from '$lib/challenges/types';
import { loadWasmCore } from '$lib/db/backend.testing';
import type { Challenge, ClozeChallenge, WordOrderChallenge } from '$lib/types';
import {
	PLANNABLE_KINDS,
	describeShown,
	getBatch,
	getEscalation,
	isMockMode,
	kindKey,
	kindOf
} from './index';
import type { BatchArgs, ProgressStep, Want, WireType } from './index';

beforeAll(loadWasmCore);

const ALL_KINDS: WireType[] = [...PLANNABLE_KINDS.map((kind) => kind.type), 'translate-to-target'];

function batch(targetLanguage: string, kinds: WireType[] = ALL_KINDS): BatchArgs {
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
		it(`writes one valid stored challenge per want, of the kind asked (${target})`, async () => {
			const result = await getBatch(batch(target));
			expect(result.challenges.map((c) => kindOf(c)?.type)).toEqual(ALL_KINDS);
			for (const challenge of result.challenges) {
				expect(challengeSchema.safeParse(challenge).success, challenge.type).toBe(true);
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

	it('states each plannable kind’s demand as its resolved challenge reports it', async () => {
		const { challenges } = await getBatch(
			batch(
				'Spanish',
				PLANNABLE_KINDS.map((k) => k.type)
			)
		);
		challenges.forEach((challenge, i) => {
			expect(demandOf(challenge), PLANNABLE_KINDS[i].type).toBe(PLANNABLE_KINDS[i].demand);
		});
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

describe('kinds', () => {
	it('plans every active kind once and never the retired one', () => {
		const keys = PLANNABLE_KINDS.map(kindKey);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).not.toContain('translate-to-target');
		expect(PLANNABLE_KINDS.every((kind) => kind.demand <= 1)).toBe(true);
	});

	it('reads a match-pairs round back as no kind at all', () => {
		const round = {
			id: 'm',
			type: 'match-pairs',
			direction: 'toNative',
			pairs: [],
			itemIds: []
		} as Challenge;
		expect(kindOf(round)).toBeUndefined();
	});
});

describe('getEscalation', () => {
	const presentation = (fields: Partial<Presentation>): Presentation => ({
		showHint: true,
		bankSize: 0,
		distractorTiles: 0,
		readings: ALL_READINGS,
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
