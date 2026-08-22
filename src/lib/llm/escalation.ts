/**
 * On-demand escalation: the learner disagrees with a grade, or just wants to
 * know why.
 *
 * Grading is local and free; this is the only path that spends tokens after a
 * batch has been generated, and it is never triggered automatically. Context is
 * kept to the bare minimum — the one challenge, the one answer, the question —
 * so a typical escalation costs a few hundred tokens.
 */

import type { Challenge } from '$lib/types';
import { chatCompletion } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';

export interface EscalationArgs {
	challenge: Challenge;
	/** What the learner typed or picked. */
	answerGiven: string;
	/** The local grader's verdict, e.g. `'wrong'`. */
	verdict: string;
	/** The learner's own question; a sensible default is used when absent. */
	userQuestion?: string;
	nativeLanguage: string;
	targetLanguage: string;
}

export interface EscalationOptions {
	fetchFn?: FetchLike;
	model?: string;
	apiKey?: string;
	signal?: AbortSignal;
}

export interface EscalationResult {
	/** Plain text, in the learner's native language. */
	answer: string;
	usage: TokenUsage;
}

/** Used when the learner taps "explain" without typing a question. */
export const DEFAULT_QUESTION =
	'Explain the correct answer and whether my answer should count.';

/** Word budget for an escalation reply. Kept tight on purpose. */
export const ANSWER_WORD_LIMIT = 120;

/** Builds the two-message escalation prompt. */
export function buildEscalationPrompt(args: EscalationArgs): ChatMessage[] {
	const system = [
		`You are a precise language tutor. The learner speaks ${args.nativeLanguage} and is learning ${args.targetLanguage}.`,
		`Write your reply in ${args.nativeLanguage}, as plain text, at most ${ANSWER_WORD_LIMIT} words.`,
		'Answer exactly what was asked and nothing else. No greeting, no praise, no encouragement, no restating the question, no markdown.',
		'If the learner is right that their answer should count, say so plainly.'
	].join(' ');

	const user = [
		JSON.stringify({
			challenge: args.challenge,
			answerGiven: args.answerGiven,
			verdict: args.verdict
		}),
		`Question: ${args.userQuestion?.trim() || DEFAULT_QUESTION}`
	].join('\n');

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user }
	];
}

/** Asks the model the learner's follow-up question about one graded answer. */
export async function escalate(
	args: EscalationArgs,
	opts: EscalationOptions = {}
): Promise<EscalationResult> {
	const completion = await chatCompletion({
		messages: buildEscalationPrompt(args),
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn,
		// ~120 words of prose, with headroom for accented scripts.
		maxTokens: 400,
		temperature: 0.3
	});

	return { answer: completion.content.trim(), usage: completion.usage };
}
