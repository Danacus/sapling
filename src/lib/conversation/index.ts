/**
 * Public surface of conversation mode.
 *
 * The UI should only ever need {@link startConversation}, {@link sendTurn} and
 * the turn types: it holds a `ConversationTurn[]`, appends what the learner
 * wrote, awaits the {@link TurnResult}, pins the returned correction onto that
 * learner turn and pushes the teacher's. The mock/real split, the tool loop and
 * every write are inside.
 *
 * The whole write surface is one tool — `add_words`, reused verbatim from
 * `$lib/assistant/tools` — reached through the injected `ToolContext`. Nothing
 * in this module imports `$lib/db`, which is what keeps it testable in node and
 * what makes every word the teacher files a real repository write with a sync
 * event behind it.
 *
 * Nothing else survives a session: the transcript lives in the page's `$state`
 * and a reload starts a new scene.
 */

import { isMockMode } from '$lib/llm';
import type { Profile } from '$lib/types';
import { mockScenario, mockTurn } from './mock';
import { requestScenario } from './scenario';
import type { ScenarioArgs, ScenarioOptions } from './scenario';
import { runTurn } from './teacher';
import type { ConversationTurn, TurnOptions, TurnResult } from './teacher';
import type { Scenario } from './schemas';

/**
 * The scene for one session: the real setup call when a key is configured, the
 * deterministic mock otherwise — the same dispatch `getBatch` and
 * `sendChatMessage` make.
 */
export async function startConversation(
	args: ScenarioArgs,
	opts: ScenarioOptions = {}
): Promise<Scenario> {
	if (isMockMode()) return mockScenario(args);
	return requestScenario(args, opts);
}

/** One exchange, mock-aware in the same way. */
export async function sendTurn(
	history: ConversationTurn[],
	scenario: Scenario,
	text: string,
	profile: Profile,
	opts: TurnOptions = {}
): Promise<TurnResult> {
	if (isMockMode()) return mockTurn(history, scenario, text, profile, opts);
	return runTurn(history, scenario, text, profile, opts);
}

export { alignedForm, correctionSpans, diffCorrection, hasChanges, sameRomanization } from './diff';
export type { DiffKind, DiffOptions, DiffSpan } from './diff';

export { mockScenario, mockTurn } from './mock';

export {
	MAX_SCENARIO_TOKENS,
	MAX_TOPIC_CHARS,
	buildScenarioPrompt,
	parseScenario,
	requestScenario
} from './scenario';
export type { ScenarioArgs, ScenarioOptions } from './scenario';

export {
	SCENARIO_SCHEMA_NAME,
	TEACHER_REPLY_SCHEMA_NAME,
	correctionSchema,
	scenarioJsonSchema,
	scenarioSchema,
	targetTextSchema,
	teacherReplyJsonSchema,
	teacherReplySchema
} from './schemas';
export type { Correction, Scenario, TargetLine, TeacherReply } from './schemas';

export {
	MAX_CONTEXT_WORDS,
	MAX_REPLY_TOKENS,
	MAX_TOOL_ROUNDS,
	ROUND_LIMIT_REPLY,
	buildSystemPrompt,
	buildWordBlock,
	parseTeacherReply,
	runTurn
} from './teacher';
export type {
	ConversationTurn,
	LearnerTurn,
	TeacherTurn,
	TurnOptions,
	TurnResult
} from './teacher';
