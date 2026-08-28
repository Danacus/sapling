/**
 * The setup call: one request that decides what the two of you are playing.
 *
 * It is separate from the turn loop because it answers a different question
 * ("what is this scene?") and it answers it once. Keeping it out of the loop is
 * what lets the teacher's system prompt state the scene as a fact rather than
 * negotiate it, and it is why the scenario card can be on screen before the
 * first line of target language arrives.
 *
 * Everything the learner reads here is in their native language: the point of
 * the card is that the setup is understood *before* the immersion starts.
 */

import { LlmError, chatCompletion, stripFences } from '$lib/llm';
import type { ChatMessage, FetchLike } from '$lib/llm';
import type { Profile } from '$lib/types';
import { SCENARIO_SCHEMA_NAME, scenarioJsonSchema, scenarioSchema } from './schemas';
import type { Scenario, TargetLine } from './schemas';

export interface ScenarioArgs {
	profile: Profile;
	/** The learner's free-form topic. Blank means "you choose". */
	topic?: string;
}

/** Test seams and per-call overrides. Production passes none of them. */
export interface ScenarioOptions {
	signal?: AbortSignal;
	fetchFn?: FetchLike;
	apiKey?: string;
	model?: string;
}

/** Enough for "arguing about football with my brother", short enough to stay a topic. */
export const MAX_TOPIC_CHARS = 120;

/**
 * Room for a scene, three roles and an opening line, with the reading that a
 * non-Latin script needs.
 *
 * A ceiling rather than a budget — unused tokens are not billed — and this call
 * happens once per session, so there is nothing to save here. A scene that
 * stops halfway is unrecoverable in a way a truncated turn is not: the whole
 * session fails to start.
 */
export const MAX_SCENARIO_TOKENS = 2000;

/** Builds the two messages for one setup call. */
export function buildScenarioPrompt(args: ScenarioArgs): ChatMessage[] {
	const { profile } = args;
	const topic = args.topic?.trim().slice(0, MAX_TOPIC_CHARS);

	const system = [
		`You set up role-play scenes for a ${profile.level} learner of ${profile.targetLanguage} whose native language is ${profile.nativeLanguage}.`,
		'Return one JSON object and nothing else: {"setting","teacherRole","learnerRole","firstSpeaker","opener","openerTranslation"}.',
		`Write "setting", "teacherRole" and "learnerRole" in ${profile.nativeLanguage}: the learner has to understand the setup before the ${profile.targetLanguage} starts. "setting" is one sentence; the two roles are short noun phrases such as "the person behind the counter".`,
		'Pick an everyday scene two people can talk their way through, with a reason to keep asking each other things. Nothing that resolves in two lines.',
		'"firstSpeaker" is "teacher" or "learner", whichever the scene makes natural.',
		`"opener" is your first line in ${profile.targetLanguage} as {"text","reading"} — a natural greeting or question in character, at the learner's level. Set it to null when "firstSpeaker" is "learner".`,
		`"reading" is the Latin-script reading of "text" when ${profile.targetLanguage} is not written in the Latin script, and null when it is.`,
		`"openerTranslation" is that same opening line in ${profile.nativeLanguage}. Write it whenever there is an opener, and null only when "opener" is null.`
	].join(' ');

	const user = topic
		? `Topic the learner asked for: ${topic}`
		: 'The learner did not name a topic. Choose one.';

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: user }
	];
}

/** `null`/blank reading normalized away, so a missing reading is one state, not three. */
function toLine(raw: { text: string; reading?: string | null }): TargetLine {
	const reading = raw.reading?.trim();
	return reading ? { text: raw.text, reading } : { text: raw.text };
}

/**
 * Reads one setup completion.
 *
 * Stricter than {@link parseTeacherReply} on purpose: a turn that will not parse
 * can degrade to prose and the conversation carries on, but there is no
 * salvaging a scene the app cannot describe — without roles there is nothing to
 * put on the card and nothing to tell the teacher it is playing. The start
 * screen surfaces the failure and offers another go.
 *
 * The one thing normalized rather than rejected is the `firstSpeaker`/`opener`
 * agreement: a teacher-first scene with no opening line becomes learner-first
 * (the learner simply starts), and an opener on a learner-first scene is
 * dropped rather than jumping the queue.
 */
export function parseScenario(raw: string): Scenario {
	let json: unknown;
	try {
		json = JSON.parse(stripFences(raw));
	} catch (cause) {
		throw new LlmError('bad-response', 'The model did not return a scene. Try again.', { cause });
	}

	const parsed = scenarioSchema.safeParse(json);
	if (!parsed.success) {
		throw new LlmError('bad-response', 'The model returned a scene in an unexpected shape.');
	}

	const { setting, teacherRole, learnerRole, opener, openerTranslation } = parsed.data;
	const line = opener ? toLine(opener) : undefined;
	const firstSpeaker = parsed.data.firstSpeaker === 'teacher' && line ? 'teacher' : 'learner';
	const translation = openerTranslation?.trim();

	return {
		setting,
		teacherRole,
		learnerRole,
		firstSpeaker,
		...(firstSpeaker === 'teacher' && line
			? { opener: line, ...(translation ? { openerTranslation: translation } : {}) }
			: {})
	};
}

/** The real setup call; {@link startConversation} in `./index` picks it or the mock. */
export async function requestScenario(
	args: ScenarioArgs,
	opts: ScenarioOptions = {}
): Promise<Scenario> {
	const completion = await chatCompletion({
		messages: buildScenarioPrompt(args),
		responseFormat: { schema: scenarioJsonSchema(), name: SCENARIO_SCHEMA_NAME },
		maxTokens: MAX_SCENARIO_TOKENS,
		temperature: 0.9,
		model: opts.model,
		apiKey: opts.apiKey,
		signal: opts.signal,
		fetchFn: opts.fetchFn
	});

	return parseScenario(completion.content);
}
