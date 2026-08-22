import { describe, expect, it } from 'vitest';
import type { Challenge } from '$lib/types';
import type { FetchLike } from './client';
import { ANSWER_WORD_LIMIT, DEFAULT_QUESTION, buildEscalationPrompt, escalate } from './escalation';

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

describe('buildEscalationPrompt', () => {
	it('pins the reply language, the word limit and the no-flattery rule', () => {
		const [system] = buildEscalationPrompt(base);
		expect(system.content).toContain('Dutch');
		expect(system.content).toContain('Spanish');
		expect(system.content).toContain(String(ANSWER_WORD_LIMIT));
		expect(system.content).toMatch(/no praise/i);
	});

	it('carries only the challenge, the answer and the verdict as context', () => {
		const [, user] = buildEscalationPrompt(base);
		const [payload, question] = user.content.split('\n');
		expect(JSON.parse(payload)).toEqual({
			challenge,
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
});

describe('escalate', () => {
	it('returns the trimmed reply and its usage', async () => {
		let body: Record<string, unknown> = {};
		const fetchFn: FetchLike = async (_url, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					model: 'test/model',
					choices: [{ message: { content: '  "Ser" is permanent; use "estar".  ' } }],
					usage: { prompt_tokens: 180, completion_tokens: 40 }
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			);
		};

		const result = await escalate(base, { fetchFn, apiKey: 'sk-or-test', model: 'test/model' });

		expect(result.answer).toBe('"Ser" is permanent; use "estar".');
		expect(result.usage).toEqual({ promptTokens: 180, completionTokens: 40 });
		// No structured output on this path: it is plain prose.
		expect(body.response_format).toBeUndefined();
		expect(body.max_tokens).toBe(400);
	});
});
