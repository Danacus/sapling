/**
 * Conversation mode. The setup call, the turn loop, the envelope and the
 * offline mock are Rust (`crates/sapling-llm`); the one tool is the
 * assistant's own `add_words`, over the same word list. What stays here is
 * presentation: `./diff`, the inline correction markup.
 *
 * Persisting is the page's job: the scene and every completed exchange are
 * events written from `src/routes/converse/`.
 */

import { defaultToolContext } from '$lib/assistant';
import type {
	ConversationCorrection,
	ConversationLearnerTurn,
	ConversationLine,
	ConversationScenario,
	ConversationTeacherTurn,
	ConversationTurn,
	LearnerProfile,
	TurnResult
} from '$lib/db/generated/index';
import { callLlm } from '$lib/llm';
import type { CallOptions } from '$lib/llm';

export type { ConversationTurn, TurnResult };
export type Scenario = ConversationScenario;
export type TargetLine = ConversationLine;
export type Correction = ConversationCorrection;
export type LearnerTurn = ConversationLearnerTurn;
export type TeacherTurn = ConversationTeacherTurn;

export interface ScenarioArgs {
	profile: LearnerProfile;
	/** Blank means "you choose". */
	topic?: string;
}

/** The scene for one session. A scene that will not parse rejects. */
export function startConversation(args: ScenarioArgs, opts: CallOptions = {}): Promise<Scenario> {
	return callLlm('startConversation', args, opts);
}

/** One exchange: the teacher's turn, plus what belongs on the learner's bubble. */
export function sendTurn(
	history: ConversationTurn[],
	scenario: Scenario,
	text: string,
	profile: LearnerProfile,
	opts: CallOptions = {}
): Promise<TurnResult> {
	return callLlm(
		'sendTurn',
		{ profile, scenario, history, text },
		{ ...opts, tools: opts.tools ?? defaultToolContext() }
	);
}

export { alignedForm, correctionSpans, diffCorrection, hasChanges, spanGap } from './diff';
export type { DiffKind, DiffOptions, DiffSpan } from './diff';
