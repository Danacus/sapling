/**
 * Offline conversation: no key, no network, no model — but real tools.
 *
 * The same bargain `$lib/assistant/mock` strikes: the *replies* are canned,
 * everything underneath them is the production path. A `term = meaning` line in
 * the learner's message becomes a genuine `add_words` call pushed through
 * `executeToolCall` — argument JSON, schema validation, executor, real writes —
 * so the tool half of the feature is exercised every time it is used offline
 * rather than only in tests.
 *
 * The scene is one fixed Spanish café regardless of the profile, exactly as the
 * lesson mock's default fixtures are: the point is to show the shape of the
 * feature with no key, not to fake every language.
 */

import { parseWordLines } from '$lib/assistant';
import type { ActionNote } from '$lib/assistant';
import { defaultToolContext, executeToolCall } from '$lib/assistant/tools';
import type { Profile } from '$lib/types';
import type { ScenarioArgs } from './scenario';
import type { Correction, Scenario } from './schemas';
import type { ConversationTurn, TurnOptions, TurnResult } from './teacher';

/** The canned scene. Roles are native-language, as a real scenario's are. */
const MOCK_SCENARIO: Scenario = {
	setting: 'An ice cream shop on a hot afternoon.',
	teacherRole: 'the person behind the counter',
	learnerRole: 'a customer',
	firstSpeaker: 'teacher',
	opener: { text: '¡Hola! ¿Qué te pongo?' }
};

/** Cycled by the learner's message count, so the same input always replies the same. */
const MOCK_REPLIES: { text: string; translation: string }[] = [
	{ text: 'Muy bien. ¿Algo más?', translation: 'Very good. Anything else?' },
	{ text: '¿Y para beber?', translation: 'And to drink?' },
	{ text: 'Perfecto. ¿Aquí o para llevar?', translation: 'Perfect. Here or to take away?' },
	{ text: 'Claro. ¿Cómo te llamas?', translation: 'Of course. What is your name?' }
];

/** Which message gets the canned correction — the second, so the first turn reads clean. */
const CORRECTED_TURN = 1;

/** One fixed scene, with the learner's topic threaded in when they named one. */
export async function mockScenario(args: ScenarioArgs): Promise<Scenario> {
	const topic = args.topic?.trim();
	return {
		...MOCK_SCENARIO,
		setting: topic
			? `${MOCK_SCENARIO.setting} You asked to talk about: ${topic}.`
			: MOCK_SCENARIO.setting
	};
}

/**
 * The offline "correction": capitalize the opening word and end with a full
 * stop. Not language teaching — it is a rewrite of the *whole* message that
 * reliably differs from what was typed, which is what the diff and the inline
 * markup need to be developable without a key.
 */
function demoCorrection(text: string): Correction | undefined {
	const typed = text.trim();
	const capitalized = typed.charAt(0).toUpperCase() + typed.slice(1);
	const corrected = /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
	if (corrected === typed) return undefined;
	return {
		corrected: { text: corrected },
		note: 'A sentence opens with a capital and closes with a full stop.'
	};
}

/** One turn, offline. Deterministic: same history and message, same reply, same writes. */
export async function mockTurn(
	history: ConversationTurn[],
	_scenario: Scenario,
	text: string,
	_profile: Profile,
	opts: TurnOptions = {}
): Promise<TurnResult> {
	const spoken = history.filter((turn) => turn.role === 'learner').length;
	const canned = MOCK_REPLIES[spoken % MOCK_REPLIES.length];

	const words = parseWordLines(text);
	const actions: ActionNote[] = [];
	if (words.length > 0) {
		const ctx = defaultToolContext(opts.deps);
		const outcome = await executeToolCall(
			{ name: 'add_words', arguments: JSON.stringify({ words }) },
			ctx
		);
		actions.push({ tool: 'add_words', summary: outcome.summary, ok: outcome.ok !== false });
	}

	const correction = spoken === CORRECTED_TURN ? demoCorrection(text) : undefined;

	return {
		teacher: {
			role: 'teacher',
			reply: { text: canned.text },
			translation: canned.translation,
			actions
		},
		...(correction ? { correction } : {})
	};
}
