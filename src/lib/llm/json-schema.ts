/**
 * One conversion from zod to the JSON Schema dialect this app sends over the
 * wire, shared by the two places that need it: the structured-output schema for
 * a lesson batch (`schemas.ts`) and the assistant's tool-argument schemas
 * (`$lib/assistant/tools`).
 *
 * The options are the load-bearing part, which is why they live here rather
 * than being written out at each call site. `$defs`/`$ref` are inlined because
 * several cheap models choke on references — which matters more now that
 * `TargetText` appears in almost every wire type — and `$schema` is dropped
 * because providers reject the key.
 *
 * What callers layer on top differs and stays theirs: the batch schema runs a
 * `required`-everything pass for strict structured outputs, while a tool
 * argument must keep its optionals optional, or a model would be forced to
 * invent a `query` for a list it wants in full.
 */
import { z } from 'zod';

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema, {
		target: 'draft-2020-12',
		reused: 'inline',
		unrepresentable: 'any',
		io: 'input'
	}) as Record<string, unknown>;
	delete json.$schema;
	return json;
}
