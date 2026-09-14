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

import {
	resolvedPresentation,
	visibleBank,
	visibleTiles
} from '$lib/challenges/serve/presentation';
import type { Presentation } from '$lib/challenges/serve/presentation';
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
	/**
	 * The presentation the challenge was actually served with — the same object
	 * `$lib/challenges/serve/presentation`'s `presentationFor` hands to
	 * `ChallengeHost`. Threaded through so the escalation can tell the model what
	 * the learner actually saw (`describeShown`, below) rather than judging a
	 * dispute against the full stored row, which may carry a native-language line
	 * or bank/tray entries the learner's screen never showed.
	 *
	 * Absent — old callers, every existing test — means "assume everything
	 * stored was shown", exactly the behaviour before this field existed:
	 * `resolvedPresentation` already defines that default for a bare render, and
	 * this reuses it rather than repeating it.
	 */
	presentation?: Presentation;
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
export const DEFAULT_QUESTION = 'Explain the correct answer and whether my answer should count.';

/** Word budget for an escalation reply. Kept tight on purpose. */
export const ANSWER_WORD_LIMIT = 120;

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
const SHAPE_GLOSS = [
	"The challenge JSON is the app's own stored shape. Most types are self-describing; the exceptions:",
	...WIRE_TYPE_DEFS.map((def) => def.escalationSpec).filter((spec): spec is string => !!spec)
].join(' ');

/**
 * What the model has to be told about the `shown` field, below — a describable
 * gap between "everything this row has stored" and "what the learner's screen
 * actually displayed", which is exactly what a served challenge can be at rung
 * 3+ (`$lib/challenges/serve/presentation`). Without this, a model reading the
 * full `challenge` object would assume the native-language line and the whole
 * bank/tray were on screen, and confidently reject an answer for contradicting
 * a sentence the learner never saw.
 */
const SHOWN_GLOSS =
	'"shown" describes what the learner\'s screen actually displayed, which can be less than the full stored "challenge": "nativeLine" says whether the native-language line (the prompt, translation hint, or intended meaning, whichever the type stores) was visible; "wordBank"/"tiles", when present, list only the bank entries or tiles the learner could actually pick from — the stored challenge may hold more that never rendered.';

/** What `buildEscalationPrompt`'s `shown` field actually names, per challenge type. */
interface Shown {
	nativeLine: boolean;
	wordBank?: string[];
	tiles?: string[];
}

/**
 * What the learner's own screen showed for this challenge — never the full
 * stored row, which a served challenge routinely outgrows (see
 * {@link Presentation}). Built from the same `visibleBank`/`visibleTiles`
 * helpers the learn screen's components use to pick which stored entries to
 * render, so this can never drift from what actually rendered.
 *
 * With no `presentation` — every caller before this field existed, and every
 * existing test — {@link resolvedPresentation}'s own "show everything stored"
 * default takes over, which is exactly the old behaviour: `nativeLine: true`
 * and a bank/tray that is the full stored one.
 */
function describeShown(challenge: Challenge, presentation?: Presentation): Shown {
	const resolved = resolvedPresentation(challenge, presentation);
	const shown: Shown = { nativeLine: resolved.showHint };
	if (challenge.type === 'cloze' || challenge.type === 'multi-cloze') {
		const bank = challenge.wordBank ?? [];
		shown.wordBank = visibleBank(challenge, resolved.bankSize).map((at) => bank[at]!);
	} else if (challenge.type === 'word-order') {
		shown.tiles = visibleTiles(challenge, resolved.distractorTiles).map(
			(at) => challenge.tiles[at]!
		);
	}
	return shown;
}

/** Builds the two-message escalation prompt. */
export function buildEscalationPrompt(args: EscalationArgs): ChatMessage[] {
	const shown = describeShown(args.challenge, args.presentation);
	const system = [
		`You are a precise language tutor. The learner speaks ${args.nativeLanguage} and is learning ${args.targetLanguage}.`,
		'Reply with one JSON object and nothing else, no markdown fences: {"answer": string, "overturn": boolean}.',
		`"answer": your reply in ${args.nativeLanguage}, plain text, at most ${ANSWER_WORD_LIMIT} words. Answer exactly what was asked and nothing else. No greeting, no praise, no encouragement, no restating the question, no markdown.`,
		SHAPE_GLOSS,
		SHOWN_GLOSS,
		'"overturn": true ONLY when the answer the learner gave should genuinely have been accepted as correct for the challenge exactly as it was shown — a valid alternative translation, a synonym, or an acceptable register or spelling variant that the accepted answers simply missed.',
		'When "shown.nativeLine" is false, the learner was never told which exact sentence or meaning the row intended, so the stored answer is not the only right one: overturn when their answer is a correct, natural result for what they could actually see on screen. For word-order, that means any grammatical, natural sentence built from exactly the tiles listed in "shown.tiles", using the same number of tiles as "answerTokens" has. For cloze or multi-cloze, that means a word from "shown.wordBank" that fits the gap grammatically and naturally, even one that differs from the stored answer. For spot-error, that means any word in "tokens" that is genuinely wrong there, with a valid correction — not only the one this row happened to plant. When "shown.nativeLine" is true, the stricter rule above stands instead: the answer has to mean what that line says.',
		'Never overturn out of politeness, encouragement, or because the learner insists. If their answer changes the meaning, is ungrammatical, or answers a different question than the one asked, "overturn" is false and the explanation says why.',
		'When you overturn, "answer" states plainly that their answer counts and why it is valid.'
	].join(' ');

	const user = [
		JSON.stringify({
			challenge: args.challenge,
			shown,
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
