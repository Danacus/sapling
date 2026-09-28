/**
 * The model calls that live in Rust (`crates/sapling-llm`), run on the window
 * thread: the wasm build's `llm` export, with this thread's `fetch` as the
 * transport. Rust owns the prompts, the parsing and mock mode; this module
 * lends it the endpoint the learner configured and records what it spent.
 */

import { DEFAULT_MODEL, getApiKey, getBaseUrl, getModel } from '$lib/db/settings';
import type {
	Endpoint,
	ProgressStep,
	LlmError as WireError,
	TokenUsage
} from '$lib/db/generated/index';
import type { Llm } from '$lib/db/generated/llm';
import init, { llm } from '$lib/db/wasm/sapling_core';
import wasmUrl from '$lib/db/wasm/sapling_core_bg.wasm?url';
import { LlmError } from './client';
import { isMockMode } from './mock';
import { recordUsage } from './usage';

export interface CallOptions {
	signal?: AbortSignal;
	/** For the calls that report progress (`generateBatch`). */
	onProgress?: (step: ProgressStep) => void;
}

let ready: Promise<unknown> | undefined;

function endpoint(): string | undefined {
	if (isMockMode()) return undefined;
	const live: Endpoint = {
		apiKey: getApiKey() ?? '',
		model: getModel() || DEFAULT_MODEL,
		baseUrl: getBaseUrl()
	};
	return JSON.stringify(live);
}

function poster(signal?: AbortSignal) {
	return async (url: string, headers: string, body: string): Promise<string> => {
		const response = await fetch(url, {
			method: 'POST',
			headers: JSON.parse(headers) as Record<string, string>,
			body,
			signal
		});
		return JSON.stringify({ status: response.status, body: await response.text() });
	};
}

/** A rejection from the core: an `LlmError` as JSON, or plain text for a malformed call. */
function failure(error: unknown): Error {
	const text = String(error);
	try {
		const wire = JSON.parse(text) as WireError;
		if (typeof wire?.kind === 'string') {
			return new LlmError(wire.kind, wire.message, { status: wire.status });
		}
	} catch {
		/* plain text */
	}
	return new Error(text);
}

/** One model call by name. An aborted call rejects with the signal's reason. */
export async function callLlm<M extends keyof Llm>(
	method: M,
	args: Parameters<Llm[M]>[0],
	opts: CallOptions = {}
): Promise<Awaited<ReturnType<Llm[M]>>> {
	ready ??= init({ module_or_path: wasmUrl });
	await ready;
	let answer: string;
	try {
		const progress = opts.onProgress;
		answer = await llm(
			method,
			JSON.stringify([args]),
			endpoint(),
			poster(opts.signal),
			progress && ((step: string) => progress(JSON.parse(step) as ProgressStep))
		);
	} catch (error) {
		opts.signal?.throwIfAborted();
		throw failure(error);
	}
	const { result, usage } = JSON.parse(answer) as {
		result: Awaited<ReturnType<Llm[M]>>;
		usage?: TokenUsage;
	};
	if (usage) recordUsage(usage);
	return result;
}
