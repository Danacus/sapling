/**
 * Public surface of the LLM layer.
 *
 * The UI should only ever need {@link getBatch}, {@link getEscalation} and
 * {@link makeMatchPairsChallenge}: they dispatch between the real OpenRouter
 * path and the offline mock automatically, based on whether a key is
 * configured.
 *
 * Nothing in this layer touches the database. `getBatch` returns `newItems`
 * with `fsrsCard: null`; the caller initializes card state via `$lib/srs` and
 * persists the result.
 */

import { escalate } from './escalation';
import type { EscalationArgs, EscalationOptions, EscalationResult } from './escalation';
import { generateBatch } from './generate';
import type { BatchArgs, BatchOptions, BatchResult } from './generate';
import { escalateMock, isMockMode, mockBatch } from './mock';

/**
 * One lesson batch: real generation when an API key is configured, the
 * deterministic mock otherwise (or when `ll.mockMode` is set).
 */
export async function getBatch(args: BatchArgs, opts: BatchOptions = {}): Promise<BatchResult> {
	if (isMockMode()) return mockBatch(args, opts);
	return generateBatch(args, opts);
}

/**
 * One follow-up explanation, mock-aware in the same way as {@link getBatch}.
 *
 * `overturn` comes back `true` when the model judges the learner's answer
 * should have counted; the mock never overturns.
 */
export async function getEscalation(
	args: EscalationArgs,
	opts: EscalationOptions = {}
): Promise<EscalationResult> {
	if (isMockMode()) return escalateMock(args);
	return escalate(args, opts);
}

// -- The rest of the layer, for callers that want the pieces ---------------

export {
	APP_REFERER,
	APP_TITLE,
	LlmError,
	OPENROUTER_BASE_URL,
	chatCompletion
} from './client';
export type {
	ChatCompletionOptions,
	ChatCompletionResult,
	ChatMessage,
	FetchLike,
	LlmErrorKind,
	ResponseFormat,
	TokenUsage
} from './client';

export {
	ANSWER_WORD_LIMIT,
	DEFAULT_QUESTION,
	buildEscalationPrompt,
	escalate,
	escalationReplySchema,
	parseEscalationReply
} from './escalation';
export type {
	EscalationArgs,
	EscalationOptions,
	EscalationReply,
	EscalationResult
} from './escalation';

export {
	CORRECTIVE_INSTRUCTION,
	MAX_BATCH_CHALLENGES,
	MIN_BATCH_CHALLENGES,
	buildBatchPrompt,
	defaultChallengeCount,
	generateBatch,
	makeMatchPairsChallenge,
	parseBatch,
	resolveBatch,
	stripFences
} from './generate';
export type {
	BatchArgs,
	BatchOptions,
	BatchProfile,
	BatchResult,
	OnProgress,
	ParsedBatch,
	ProgressStep,
	ProgressStepId,
	RecentMistake,
	ResolveOptions,
	ResolvedBatch,
	ReviewItemRef
} from './generate';

export {
	ROMANIZE_SCHEMA_NAME,
	buildRomanizePrompt,
	fillRomanizations,
	parseRomanizations,
	romanizationsSchema,
	romanizeJsonSchema
} from './romanize';
export type { RomanizeArgs, RomanizeItem, RomanizeOptions, RomanizeResult } from './romanize';

export {
	MOCK_FLAG_KEY,
	escalateMock,
	isMockMode,
	mockBatch,
	setMockMode,
	usesMandarinFixtures
} from './mock';

export {
	BATCH_SCHEMA_NAME,
	batchJsonSchema,
	challengeSchema,
	generatedBatchSchema,
	generatedChallengeSchema,
	generatedItemSchema
} from './schemas';
export type { GeneratedBatch, GeneratedChallenge, GeneratedItem } from './schemas';

export { getUsageTotals, recordUsage, resetUsage } from './usage';
export type { UsageTotals } from './usage';
