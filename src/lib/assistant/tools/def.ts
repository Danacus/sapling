/**
 * The contract one assistant tool has to satisfy.
 *
 * A tool is the whole of what the model may *do* to the learner's word list:
 * its name and description (the only things the model reads about it), the zod
 * schema its arguments must satisfy, and the executor that performs the change.
 * Adding an action — adjust a card, change a setting — is writing one of these
 * and listing it in `./index`; no other module names a tool.
 *
 * Two properties are load-bearing:
 *
 * - **Tools never touch `$lib/db` themselves.** Every side effect goes through
 *   {@link ToolContext}, so a tool is pure logic over an injected store: the
 *   node tests run the real executors against an in-memory context, and the
 *   offline mock drives the same code the paid path does.
 * - **Tools never throw for a domain failure.** A word that is not in the list
 *   is a *result* ({@link toolFailure}), because the model has to be able to
 *   read it and recover — an exception would end the turn and tell the learner
 *   nothing. Only genuine bugs throw.
 */

import type { z } from 'zod';
import type { KnowledgeItem } from '$lib/types';

/**
 * Everything a tool is allowed to depend on beyond its own arguments.
 *
 * Deliberately narrower than `$lib/db`: reads of the whole list, three writes,
 * and the two ambient facts (id source, clock) that would otherwise make a tool
 * untestable. `now()` is a function rather than a captured number because one
 * chat turn can run several tools and each write stamps its own time.
 */
export interface ToolContext {
	getAllItems(): Promise<KnowledgeItem[]>;
	upsertItems(items: KnowledgeItem[]): Promise<void>;
	deleteItem(id: string): Promise<void>;
	newId(): string;
	now(): number;
}

/** What one tool call produced, for the model and for the learner respectively. */
export interface ToolOutcome {
	/**
	 * JSON-serializable; `JSON.stringify`d and fed back to the model verbatim as
	 * the tool message. A failure carries `{ error }` and nothing else it could
	 * mistake for success.
	 */
	result: unknown;
	/** One line for the UI's action note, e.g. `Added 2 words: hola, adiós`. */
	summary: string;
	/**
	 * False when the call did not do what it was asked. Absent means it did —
	 * the common case, so the flag is opt-in rather than repeated on every
	 * success. The chat layer projects it onto `ActionNote.ok`.
	 */
	ok?: boolean;
}

/**
 * One tool, schema through executor.
 *
 * @typeParam S This tool's argument schema — what `paramsSchema` parses and what
 * `run` receives, already validated.
 */
export interface AssistantToolDef<S extends z.ZodType = z.ZodType> {
	/** snake_case, unique across the registry; what the model calls. */
	readonly name: string;
	/**
	 * What the model reads to decide whether this is the tool it wants. Concise
	 * and imperative — it is paid for on every chat request.
	 */
	readonly description: string;
	/**
	 * The argument schema, projected to JSON Schema for the wire by
	 * `./index`. It is also the only validation between a model's free-form
	 * argument JSON and the executor.
	 */
	readonly paramsSchema: S;
	run(params: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}
