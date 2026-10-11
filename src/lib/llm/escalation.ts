import type { EscalationReply } from '$lib/db/generated/index';
import type { Challenge, ChallengeScreen } from '$lib/types';
import { callLlm } from './core';
import type { CallOptions } from './core';

export interface EscalationArgs {
	challenge: Challenge;
	screen: ChallengeScreen;
	answerGiven: string;
	verdict: string;
	userQuestion?: string;
	nativeLanguage: string;
	targetLanguage: string;
}

/** The model receives the exact type-specific screen Rust served. */
export function describeShown(screen: ChallengeScreen): ChallengeScreen {
	return screen;
}

export function getEscalation(
	args: EscalationArgs,
	opts: CallOptions = {}
): Promise<EscalationReply> {
	return callLlm('escalate', { ...args, shown: describeShown(args.screen) }, opts);
}
