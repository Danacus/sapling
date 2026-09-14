import { describe, expect, it } from 'vitest';
import type { Presentation } from '$lib/challenges/serve/presentation';
import { ALL_READINGS } from '$lib/challenges/serve/reading';
import type { Challenge, ClozeChallenge, WordOrderChallenge } from '$lib/types';
import type { FetchLike } from './client';
import {
	ANSWER_WORD_LIMIT,
	DEFAULT_QUESTION,
	buildEscalationPrompt,
	escalate,
	parseEscalationReply
} from './escalation';

const challenge: Challenge = {
	id: 'c1',
	type: 'typed-translation',
	direction: 'toTarget',
	prompt: 'the water is cold',
	acceptedAnswers: ['el agua está fría'],
	itemIds: ['i1']
};

const base = {
	challenge,
	answerGiven: 'el agua es fria',
	verdict: 'wrong',
	nativeLanguage: 'Dutch',
	targetLanguage: 'Spanish'
};

/** A served cloze with a full stored bank, for the trimmed-bank case below. */
const clozeChallenge: ClozeChallenge = {
	id: 'c2',
	type: 'cloze',
	direction: 'toTarget',
	sentence: 'Nos trae la ___, por favor?',
	acceptedAnswers: ['cuenta'],
	wordBank: ['cuenta', 'carta', 'propina', 'mesa', 'servilleta'],
	translationHint: 'Could you bring us the bill, please?',
	itemIds: ['i2']
};

/** A served word-order row with two distractor tiles beyond the sentence. */
const wordOrderChallenge: WordOrderChallenge = {
	id: 'c3',
	type: 'word-order',
	direction: 'toTarget',
	prompt: 'Could you bring us the bill, please?',
	tiles: ['¿Nos', 'trae', 'la', 'cuenta,', 'por', 'favor?', 'carta', 'propina'],
	answerTokens: ['¿Nos', 'trae', 'la', 'cuenta,', 'por', 'favor?'],
	answer: '¿Nos trae la cuenta, por favor?',
	itemIds: ['i2']
};

function presentationWith(fields: Partial<Presentation>): Presentation {
	return {
		showHint: true,
		bankSize: 0,
		distractorTiles: 0,
		readings: ALL_READINGS,
		...fields
	};
}

describe('buildEscalationPrompt', () => {
	it('pins the reply language, the word limit and the no-flattery rule', () => {
		const [system] = buildEscalationPrompt(base);
		expect(system.content).toContain('Dutch');
		expect(system.content).toContain('Spanish');
		expect(system.content).toContain(String(ANSWER_WORD_LIMIT));
		expect(system.content).toMatch(/no praise/i);
	});

	it('asks for the {answer, overturn} envelope', () => {
		const [system] = buildEscalationPrompt(base);
		expect(system.content).toContain('{"answer": string, "overturn": boolean}');
	});

	it('spells out when an overturn is justified — and when it is not', () => {
		const [system] = buildEscalationPrompt(base);
		// The whole point: a dispute wins on merit, never on insistence.
		expect(system.content).toContain('ONLY when');
		expect(system.content).toMatch(/valid alternative translation/i);
		expect(system.content).toMatch(/never overturn out of politeness/i);
		expect(system.content).toMatch(/because the learner insists/i);
	});

	it('carries only the challenge, the shown view, the answer and the verdict as context', () => {
		const [, user] = buildEscalationPrompt(base);
		const [payload, question] = user.content.split('\n');
		expect(JSON.parse(payload)).toEqual({
			challenge,
			shown: { nativeLine: true },
			answerGiven: 'el agua es fria',
			verdict: 'wrong'
		});
		expect(question).toBe(`Question: ${DEFAULT_QUESTION}`);
	});

	it('uses the learner question when there is one', () => {
		const [, user] = buildEscalationPrompt({ ...base, userQuestion: '  Why not "es"?  ' });
		expect(user.content).toContain('Question: Why not "es"?');
		expect(user.content).not.toContain(DEFAULT_QUESTION);
	});

	describe('shown', () => {
		it('with no presentation, marks everything stored as shown — the pre-existing behaviour', () => {
			const [, user] = buildEscalationPrompt({ ...base, challenge: clozeChallenge });
			expect(JSON.parse(user.content.split('\n')[0]).shown).toEqual({
				nativeLine: true,
				wordBank: clozeChallenge.wordBank
			});
		});

		it('marks the native line hidden when the served presentation hid it, and relaxes the overturn rule', () => {
			const [system, user] = buildEscalationPrompt({
				...base,
				challenge: clozeChallenge,
				presentation: presentationWith({
					showHint: false,
					bankSize: clozeChallenge.wordBank!.length
				})
			});
			expect(JSON.parse(user.content.split('\n')[0]).shown.nativeLine).toBe(false);
			// The relaxed rule only has teeth if it is actually in the prompt.
			expect(system.content).toMatch(/"shown\.nativeLine" is false/);
			expect(system.content).toMatch(/not the only right one/i);
			expect(system.content).toMatch(/"shown\.nativeLine" is true/);
		});

		it('a trimmed cloze bank reports only the visible entries', () => {
			const [, user] = buildEscalationPrompt({
				...base,
				challenge: clozeChallenge,
				presentation: presentationWith({ bankSize: 2 })
			});
			// bankSizeFor/visibleBank keep the answer ('cuenta', bank position 0)
			// first, then the first surviving distractors in stored order.
			expect(JSON.parse(user.content.split('\n')[0]).shown.wordBank).toEqual(['cuenta', 'carta']);
		});

		it('a trimmed word-order tray reports only the visible tiles', () => {
			const [, user] = buildEscalationPrompt({
				...base,
				challenge: wordOrderChallenge,
				presentation: presentationWith({ distractorTiles: 1 })
			});
			// The sentence's own six tiles plus the first surviving distractor.
			expect(JSON.parse(user.content.split('\n')[0]).shown.tiles).toEqual([
				'¿Nos',
				'trae',
				'la',
				'cuenta,',
				'por',
				'favor?',
				'carta'
			]);
		});
	});
});

describe('parseEscalationReply', () => {
	it('reads a clean JSON reply', () => {
		expect(
			parseEscalationReply('{"answer":"  \\"Ser\\" is permanent.  ","overturn":false}')
		).toEqual({ answer: '"Ser" is permanent.', overturn: false });
	});

	it('reads a fenced reply, and an overturn with it', () => {
		expect(
			parseEscalationReply('```json\n{"answer":"Both forms work.","overturn":true}\n```')
		).toEqual({ answer: 'Both forms work.', overturn: true });
	});

	it('reads an object buried in chatter', () => {
		expect(
			parseEscalationReply('Sure! {"answer":"Use estar.","overturn":false} Hope that helps.')
		).toEqual({ answer: 'Use estar.', overturn: false });
	});

	it('falls back to the raw text, never to an overturn', () => {
		// Not JSON at all.
		expect(parseEscalationReply('  "Ser" is permanent; use "estar".  ')).toEqual({
			answer: '"Ser" is permanent; use "estar".',
			overturn: false
		});
		// JSON, but not our envelope.
		expect(parseEscalationReply('{"reply":"nope","overturn":"yes"}')).toEqual({
			answer: '{"reply":"nope","overturn":"yes"}',
			overturn: false
		});
		// Right shape, empty explanation.
		expect(parseEscalationReply('{"answer":"   ","overturn":true}')).toEqual({
			answer: '{"answer":"   ","overturn":true}',
			overturn: false
		});
	});
});

describe('escalate', () => {
	it('returns the parsed reply and its usage', async () => {
		let body: Record<string, unknown> = {};
		const fetchFn: FetchLike = async (_url, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					model: 'test/model',
					choices: [
						{
							message: {
								content:
									'```json\n{"answer":"\\"Ser\\" is permanent; use \\"estar\\".","overturn":false}\n```'
							}
						}
					],
					usage: { prompt_tokens: 180, completion_tokens: 40 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await escalate(base, { fetchFn, apiKey: 'sk-or-test', model: 'test/model' });

		expect(result.answer).toBe('"Ser" is permanent; use "estar".');
		expect(result.overturn).toBe(false);
		expect(result.usage).toEqual({ promptTokens: 180, completionTokens: 40 });
		// The envelope is asked for in the prompt, not pinned with a JSON schema:
		// the fallback in `parseEscalationReply` is cheaper than the extra tokens.
		expect(body.response_format).toBeUndefined();
		expect(body.max_tokens).toBe(1500);
	});

	it('carries an overturn through to the caller', async () => {
		const fetchFn: FetchLike = async () =>
			new Response(
				JSON.stringify({
					model: 'test/model',
					choices: [{ message: { content: '{"answer":"Both are fine here.","overturn":true}' } }],
					usage: { prompt_tokens: 90, completion_tokens: 20 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);

		const result = await escalate(base, { fetchFn, apiKey: 'sk-or-test' });
		expect(result).toEqual({
			answer: 'Both are fine here.',
			overturn: true,
			usage: { promptTokens: 90, completionTokens: 20 }
		});
	});

	it('degrades a non-JSON reply to prose without overturning', async () => {
		const fetchFn: FetchLike = async () =>
			new Response(
				JSON.stringify({
					model: 'test/model',
					choices: [{ message: { content: 'You were right, that should count!' } }],
					usage: { prompt_tokens: 90, completion_tokens: 20 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);

		const result = await escalate(base, { fetchFn, apiKey: 'sk-or-test' });
		expect(result.answer).toBe('You were right, that should count!');
		// Prose that *sounds* like an overturn still never changes a grade.
		expect(result.overturn).toBe(false);
	});
});
