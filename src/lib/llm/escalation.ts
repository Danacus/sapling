/**
 * The Explain/dispute call. Rust writes the prompt and reads the reply
 * (`crates/sapling-llm`'s `escalation.rs`); this side says what the learner's
 * screen showed, because only the serve layer knows.
 */

import {
	resolvedPresentation,
	visibleBank,
	visibleTiles
} from '$lib/challenges/serve/presentation';
import type { Presentation } from '$lib/challenges/serve/presentation';
import type { EscalationReply, Shown } from '$lib/db/generated/index';
import type { Challenge } from '$lib/types';
import { callLlm } from './core';
import type { CallOptions } from './core';

export interface EscalationArgs {
	challenge: Challenge;
	answerGiven: string;
	/** The local grader's verdict, e.g. `'wrong'`. */
	verdict: string;
	userQuestion?: string;
	nativeLanguage: string;
	targetLanguage: string;
	/** As served; absent reads as everything stored was shown. */
	presentation?: Presentation;
}

/** What the learner saw, built with the same helpers the components render with. */
export function describeShown(challenge: Challenge, presentation?: Presentation): Shown {
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

/** `overturn` is true when the answer should have counted; the mock never overturns. */
export function getEscalation(
	{ presentation, ...args }: EscalationArgs,
	opts: CallOptions = {}
): Promise<EscalationReply> {
	return callLlm('escalate', { ...args, shown: describeShown(args.challenge, presentation) }, opts);
}
