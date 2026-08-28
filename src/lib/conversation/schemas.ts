/**
 * The two wire envelopes conversation mode pins with `responseFormat`.
 *
 * Both are small and flat on purpose: a role-play turn is paid for on every
 * message the learner sends, so every key has to earn its tokens. The
 * envelopes are declared here as zod and projected to JSON Schema for the
 * `response_format` payload; zod stays the safety net for the cheap models that
 * reject structured outputs and get retried without them (`schemaDropped`).
 *
 * Model-emitted optional fields are `.nullish()` rather than `.optional()` —
 * models emit `null` for "not applicable" far more often than they omit a key,
 * the same reason the generation schemas do it — and the parsers in
 * `./scenario` and `./teacher` normalize `null` back to absent, so nothing
 * downstream has to hold three states for one field.
 *
 * {@link targetTextSchema} deliberately mirrors the generation layer's
 * `TargetText` primitive rather than importing it: the two wire formats
 * describe different calls and are free to drift, and a role-play envelope
 * should not be able to break a lesson batch.
 */

import { z } from 'zod';
import { toJsonSchema } from '$lib/llm/json-schema';

const nonEmpty = z.string().min(1);

/**
 * One string of the target language carrying its own Latin reading — pinyin,
 * romaji, and so on; `null` for languages already written in the Latin script,
 * which is most of them and costs those learners nothing.
 */
export const targetTextSchema = z.object({
	text: nonEmpty,
	reading: z.string().nullish()
});

/** The scene, decided once at the start of a session. */
export const scenarioSchema = z.object({
	setting: nonEmpty,
	teacherRole: nonEmpty,
	learnerRole: nonEmpty,
	firstSpeaker: z.enum(['teacher', 'learner']),
	/** The teacher's first line — present exactly when it speaks first. */
	opener: targetTextSchema.nullish()
});

/**
 * A rewrite of the learner's whole message, not a fragment: the UI derives the
 * marked-up spans by diffing it against what was actually typed (`./diff`), and
 * a fragment cannot be aligned back to a position in the original.
 *
 * It carries a reading for the same reason the spoken line does, and for one
 * more: a learner with no keyboard for the target script types the *reading*,
 * so the reading is the only side of the correction their own message can be
 * aligned against. Correcting 你有什么咖啡 against `ni yao kafe shenme` marks
 * every word wrong; correcting `nǐ yǒu shénme kāfēi` against it marks the two
 * that were.
 */
export const correctionSchema = z.object({
	corrected: targetTextSchema,
	note: z.string().nullish()
});

/**
 * One teacher turn: what it says, what that means, what it understood the
 * learner to have said, and what the learner got wrong.
 */
export const teacherReplySchema = z.object({
	reply: targetTextSchema,
	translation: z.string().nullish(),
	heard: targetTextSchema.nullish(),
	correction: correctionSchema.nullish()
});

/** Target-language text with its reading, `null` normalized away. */
export interface TargetLine {
	text: string;
	reading?: string;
}

/** The scene both sides play, as the app holds it. */
export interface Scenario {
	/** Native language: the learner has to understand the setup before the target language starts. */
	setting: string;
	teacherRole: string;
	learnerRole: string;
	firstSpeaker: 'teacher' | 'learner';
	opener?: TargetLine;
}

/** One language mistake, rewritten and optionally explained. */
export interface Correction {
	/** The learner's whole message as it should have been, with its reading. */
	corrected: TargetLine;
	note?: string;
}

/** One parsed teacher turn. */
export interface TeacherReply {
	reply: TargetLine;
	/** Native language, hidden behind a tap in the UI so reading it stays a choice. */
	translation?: string;
	/**
	 * The learner's own message in the target script — what the teacher understood
	 * them to have said, not a judgement on it.
	 *
	 * A learner typing the reading never gets to see the script they are learning
	 * unless they make a mistake, which turns the script into a reward for getting
	 * it wrong. This is the same sentence a correction would have carried, minus
	 * the correction, so a message that was right is shown in the script and can
	 * be played back exactly as a corrected one is.
	 */
	heard?: TargetLine;
	/** About the message the learner just sent, never about an earlier one. */
	correction?: Correction;
}

/** Names for the two structured-output schemas. */
export const SCENARIO_SCHEMA_NAME = 'conversation_scenario';
export const TEACHER_REPLY_SCHEMA_NAME = 'teacher_turn';

/**
 * `strict: true` structured outputs want every property listed in `required`
 * with `additionalProperties: false`; an optional key stays expressible by
 * being nullable, which is exactly how the schemas above are written.
 *
 * The batch format's equivalent pass (`tighten` in `$lib/llm/schemas`) also
 * rewrites `oneOf` and strips `minLength` for a seven-member discriminated
 * union. These two envelopes have neither, so this is the smaller half of that
 * job rather than a shared helper — extracting one would mean refactoring a
 * module this feature otherwise leaves alone.
 */
function requireEveryKey(node: unknown): void {
	if (Array.isArray(node)) {
		for (const child of node) requireEveryKey(child);
		return;
	}
	if (!node || typeof node !== 'object') return;
	const schema = node as Record<string, unknown>;

	if (Array.isArray(schema.anyOf)) requireEveryKey(schema.anyOf);
	if (schema.items) requireEveryKey(schema.items);

	const properties = schema.properties as Record<string, unknown> | undefined;
	if (properties && typeof properties === 'object') {
		for (const value of Object.values(properties)) requireEveryKey(value);
		schema.required = Object.keys(properties);
		schema.additionalProperties = false;
	}
}

function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const json = toJsonSchema(schema);
	requireEveryKey(json);
	return json;
}

/** The schema sent as `response_format.json_schema.schema` for the setup call. */
export function scenarioJsonSchema(): Record<string, unknown> {
	return strictJsonSchema(scenarioSchema);
}

/** The same, for every turn of the conversation. */
export function teacherReplyJsonSchema(): Record<string, unknown> {
	return strictJsonSchema(teacherReplySchema);
}
