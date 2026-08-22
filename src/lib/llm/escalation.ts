/**
 * Escalation: what to do when a generation attempt fails schema validation.
 *
 * Strategy sketch — retry the same model with the validation errors fed back,
 * then fall back to a stronger model, then give up with a typed error so the UI
 * can offer a cached/offline batch instead.
 */

export type EscalationStep =
	| { kind: 'retry'; attempt: number }
	| { kind: 'repair'; attempt: number; errors: string[] }
	| { kind: 'fallback-model'; model: string }
	| { kind: 'give-up'; reason: string };

export interface EscalationPolicy {
	/** Attempts against the learner's chosen model before escalating. */
	maxAttempts: number;
	/** Stronger model tried once the primary keeps failing. */
	fallbackModel?: string;
}

export const DEFAULT_POLICY: EscalationPolicy = {
	maxAttempts: 2
};

/** Decides the next step after a failed attempt. TODO. */
export function nextStep(
	_policy: EscalationPolicy,
	_attempt: number,
	_errors: string[]
): EscalationStep {
	throw new Error('TODO: nextStep');
}

/** Runs `attempt` under the policy until it succeeds or the policy gives up. TODO. */
export async function withEscalation<T>(
	_policy: EscalationPolicy,
	_attempt: (step: EscalationStep) => Promise<T>
): Promise<T> {
	throw new Error('TODO: withEscalation');
}
