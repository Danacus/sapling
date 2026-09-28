/**
 * Public surface of the LLM layer. Every model call runs in Rust
 * (`crates/sapling-llm`) through {@link callLlm}. Mock mode is decided here and
 * honoured on both sides.
 *
 * Nothing in this layer touches the database. `getBatch` returns challenges and
 * nothing else — a lesson is written *about* the vocabulary it is handed and
 * never introduces any — so the caller has only the pool to persist.
 */

import type { BatchArgs, BatchResult } from '$lib/db/generated/index';
import type { ReasoningEffort } from '$lib/db/settings';
import { callLlm } from './core';
import type { CallOptions } from './core';

export type OnProgress = NonNullable<CallOptions['onProgress']>;

export interface BatchOptions extends CallOptions {
	/** Overrides {@link REQUEST_ITEMS}; each type is still its own request. */
	itemsPerRequest?: number;
	reasoningEffort?: ReasoningEffort;
}

/** One top-up: the wants written, a few requests at a time, in request order. */
export async function getBatch(args: BatchArgs, opts: BatchOptions = {}): Promise<BatchResult> {
	const { itemsPerRequest, reasoningEffort, ...call } = opts;
	return callLlm(
		'generateBatch',
		{
			...args,
			...(itemsPerRequest === undefined ? {} : { itemsPerRequest }),
			...(reasoningEffort === undefined || reasoningEffort === 'default' ? {} : { reasoningEffort })
		},
		call
	);
}

export { describeShown, getEscalation } from './escalation';
export type { EscalationArgs } from './escalation';

export { LlmError, callLlm } from './core';
export type { CallOptions, LlmErrorKind, ToolContext } from './core';
export {
	MAX_ABOUT_CHARS,
	MAX_FOCUS_WORDS,
	MAX_TOPIC_CHARS,
	REQUEST_ITEMS
} from '$lib/db/generated/llm';
export type {
	BatchArgs,
	BatchResult,
	ChallengeKind,
	EscalationReply,
	FocusWord,
	GenerateTextArgs,
	GlossEntry,
	KnownItem,
	LearnerProfile,
	LookupWordArgs,
	ProgressStep,
	ProgressStepId,
	ReadingTextDraft,
	Shown,
	TokenUsage,
	TranslateLineArgs,
	Want,
	WantItem,
	WireType
} from '$lib/db/generated/index';

export { MOCK_FLAG_KEY, isMockMode, setMockMode } from './mock';

export { getUsageTotals, recordUsage, resetUsage } from './usage';
export type { UsageTotals } from './usage';
