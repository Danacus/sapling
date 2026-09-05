/**
 * The tool registry: the one place that knows how many actions the assistant
 * has.
 *
 * {@link ASSISTANT_TOOLS} is ordered, and the order is the order the model is
 * shown them in every request — read-before-write reads best, so `add_words`
 * and `list_words` come before the two that change an existing entry.
 *
 * A tool that is not listed here does not exist: it is never described to the
 * model, and {@link executeToolCall} refuses a call naming it. Everything
 * downstream is a projection of this array — the `tools` payload
 * ({@link toolDefsForClient}), the dispatch, the mock's own tool runs.
 *
 * **Adding a tool**: write `./<name>.ts` — `name`, `description`,
 * `paramsSchema`, `run` — and list it below.
 */

import { z } from 'zod';
import type { ToolDef } from '$lib/llm';
import { toJsonSchema } from '$lib/llm/json-schema';
import { addWordsTool } from './add-words';
import type { AssistantToolDef, ToolContext, ToolOutcome } from './def';
import { listWordsTool } from './list-words';
import { removeWordTool } from './remove-word';
import { toolFailure } from './primitives';
import { updateWordTool } from './update-word';

export type { AssistantToolDef, ToolContext, ToolOutcome } from './def';
export { defaultToolContext } from './context';
export {
	countWords,
	findByTerm,
	nonEmpty,
	optionalText,
	termKey,
	toolFailure,
	trimmedOrUndefined,
	wordView
} from './primitives';
export type { WordView } from './primitives';
export { ALREADY_PRESENT, MAX_WORDS_PER_CALL, addWordsParams, addWordsTool } from './add-words';
export { DEFAULT_LIMIT, MAX_LIMIT, listWordsParams, listWordsTool } from './list-words';
export { removeWordParams, removeWordTool } from './remove-word';
export { updateWordParams, updateWordTool } from './update-word';

/**
 * Every tool, in the order the model is shown them.
 *
 * Typed as the erased {@link AssistantToolDef} rather than a `const` tuple: the
 * dispatch below keys a def on the very name it was looked up by and then feeds
 * it what *its own* schema parsed, so nothing downstream needs each member's
 * precise argument type — while each def keeps it locally, via `satisfies`, for
 * its own `run` to be checked against.
 */
export const ASSISTANT_TOOLS: readonly AssistantToolDef[] = [
	addWordsTool,
	listWordsTool,
	updateWordTool,
	removeWordTool
];

/** Lookup by the name the model called, or `undefined` for a name we do not have. */
export function assistantToolByName(name: string): AssistantToolDef | undefined {
	return ASSISTANT_TOOLS.find((tool) => tool.name === name);
}

/**
 * The `tools` payload sent with every chat request.
 *
 * Note what is *not* done to these schemas, unlike `batchJsonSchemaFor` in
 * `$lib/llm/schemas`: no `required`-everything tightening. That rewrite exists
 * to satisfy strict structured outputs, where the model must emit every key;
 * here an optional argument has to stay optional, or a model would be forced to
 * invent a `query` for a list it wants in full.
 */
export function toolDefsForClient(): ToolDef[] {
	return ASSISTANT_TOOLS.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: toJsonSchema(tool.paramsSchema)
	}));
}

/**
 * Runs one tool call the model asked for.
 *
 * Every way this can go wrong — a name we do not have, argument text that is
 * not JSON, arguments that do not fit the schema — comes back as a
 * {@link toolFailure}, because all three are recoverable *by the model*: it
 * reads the tool message and tries again with the shape the error named. The
 * loop in `../chat` therefore never has to distinguish a failed call from a
 * successful one, and the learner never sees a chat turn end in an exception.
 */
export async function executeToolCall(
	call: { name: string; arguments: string },
	ctx: ToolContext
): Promise<ToolOutcome> {
	const tool = assistantToolByName(call.name);
	if (!tool) return toolFailure(`no tool named ${call.name}`);

	let args: unknown;
	try {
		args = JSON.parse(call.arguments.trim() || '{}');
	} catch {
		return toolFailure('the arguments were not valid JSON; send them again as one JSON object');
	}

	const parsed = tool.paramsSchema.safeParse(args);
	if (!parsed.success) return toolFailure(`invalid arguments: ${issueText(parsed.error)}`);

	return tool.run(parsed.data, ctx);
}

/** The first validation issue, as one sentence the model can act on. */
function issueText(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return 'they did not match the schema';
	const path = issue.path.join('.');
	return path ? `${path}: ${issue.message}` : issue.message;
}
