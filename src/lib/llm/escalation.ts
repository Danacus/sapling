/**
 * On-demand escalation: the learner disagrees with a grade, or just wants to
 * know why.
 *
 * Grading is local and free; this is the only path that spends tokens after a
 * batch has been generated, and it is never triggered automatically. Context is
 * kept to the bare minimum — the one challenge, the one answer, the question —
 * so a typical escalation costs a few hundred tokens.
 *
 * The reply is structured (`{answer, overturn}`) rather than prose, because a
 * dispute can actually win: `overturn: true` tells the session to re-grade the
 * answer as correct. That is why the criterion for it is spelled out in the
 * prompt and why {@link parseEscalationReply} refuses to guess.
 */

import { z } from 'zod';

import type { Challenge } from '$lib/types';
import { WIRE_TYPE_DEFS } from './challenge-types';
import { chatCompletion } from './client';
import type { ChatMessage, FetchLike, TokenUsage } from './client';
import { stripFences } from './generate';

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

/** What the model is asked to return, once parsed. */
export interface EscalationReply {
	/** Plain text, in the learner's native language. */
	answer: string;
	/**
	 * True when the learner's answer should have been graded correct after all.
	 * The session acts on this: see `applyOverturn` in `$lib/session/engine`.
	 */
	overturn: boolean;
}

export interface EscalationResult extends EscalationReply {
	usage: TokenUsage;
}

/** The reply envelope. Anything else falls back to prose (see {@link parseEscalationReply}). */
export const escalationReplySchema = z.object({
	answer: z.string(),
	overturn: z.boolean()
});

/** Used when the learner taps "explain" without typing a question. */
export const DEFAULT_QUESTION =
	'Explain the correct answer and whether my answer should count.';

/** Word budget for an escalation reply. Kept tight on purpose. */
export const ANSWER_WORD_LIMIT = 120;

/** Spelled-out counts for {@link SHAPE_GLOSS}; a bare numeral past the table. */
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];

/**
 * What the model has to be told about the *stored* challenge shapes before it
 * can judge a dispute about one.
 *
 * Most stored challenges explain themselves — a `prompt` and `acceptedAnswers`
 * need no gloss — but the tile-based types do not say which array the learner
 * rearranged or which index holds the wrong word, and a model that guesses will
 * confidently overturn a correct grade. Only the types that need it carry an
 * `escalationSpec`, so this sentence is composed from the registry (in the same
 * order as the batch prompt's `Types:` block) rather than listing them by hand:
 * a new tile-based type describes itself here by existing, and a type that stops
 * needing a gloss stops paying for one.
 */
const SHAPE_GLOSS = ((): string => {
	const lead = "The challenge JSON is the app's own stored shape.";
	const specs = WIRE_TYPE_DEFS.map((def) => def.escalationSpec).filter(
		(spec): spec is string => !!spec
	);
	if (!specs.length) return lead;
	const count = COUNT_WORDS[specs.length] ?? String(specs.length);
	const verb = specs.length === 1 ? 'is' : 'are';
	return [`${lead} Most types are self-describing; ${count} ${verb} not.`, ...specs].join(' ');
})();

/** Builds the two-message escalation prompt. */
export function buildEscalationPrompt(args: EscalationArgs): ChatMessage[] {
	const system = [
		`You are a precise language tutor. The learner speaks ${args.nativeLanguage} and is learning ${args.targetLanguage}.`,
		'Reply with one JSON object and nothing else, no markdown fences: {"answer": string, "overturn": boolean}.',
		`"answer": your reply in ${args.nativeLanguage}, plain text, at most ${ANSWER_WORD_LIMIT} words. Answer exactly what was asked and nothing else. No greeting, no praise, no encouragement, no restating the question, no markdown.`,
		SHAPE_GLOSS,
		'"overturn": true ONLY when the answer the learner gave should genuinely have been accepted as correct for the challenge exactly as it was shown — a valid alternative translation, a synonym, or an acceptable register or spelling variant that the accepted answers simply missed.',
		'Never overturn out of politeness, encouragement, or because the learner insists. If their answer changes the meaning, is ungrammatical, or answers a different question than the one asked, "overturn" is false and the explanation says why.',
		'When you overturn, "answer" states plainly that their answer counts and why it is valid.'
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

/**
 * Reads one escalation completion.
 *
 * Defensive on purpose: the reply drives a *grade change*, so anything that is
 * not unambiguously `{"answer","overturn"}` degrades to the old behaviour —
 * the raw text shown as the explanation, and no overturn. Fences and chatter
 * around the object are stripped first ({@link stripFences}), because cheap
 * models add them however the prompt is worded.
 */
export function parseEscalationReply(raw: string): EscalationReply {
	const text = raw.trim();
	try {
		const parsed = escalationReplySchema.safeParse(JSON.parse(stripFences(text)));
		if (parsed.success) {
			const answer = parsed.data.answer.trim();
			if (answer) return { answer, overturn: parsed.data.overturn };
		}
	} catch {
		/* not JSON at all; fall through to the prose fallback */
	}
	return { answer: text, overturn: false };
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
		// Generous on purpose: a truncated reply is a truncated explanation the
		// learner explicitly asked for, and on models that spend reasoning tokens
		// against max_tokens a tight cap cuts off mid-thought before the JSON even
		// starts. Escalation is rare and user-initiated, so the headroom costs
		// nothing until it is genuinely used.
		maxTokens: 1500,
		temperature: 0.3
	});

	return { ...parseEscalationReply(completion.content), usage: completion.usage };
}
