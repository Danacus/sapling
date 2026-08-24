/**
 * Offline chat: no key, no network, no model — but real tools.
 *
 * The same bargain `$lib/llm/mock` strikes for lesson generation: the *reply*
 * is canned, everything underneath it is the production path. A recognized
 * message is turned into a genuine tool call and pushed through
 * `executeToolCall` — argument JSON, schema validation, executor, real writes —
 * so the offline mode adds words the learner actually keeps, and the tool layer
 * is exercised every time it is used rather than only in tests.
 *
 * What it understands is deliberately tiny, because it is a demo of the shape
 * of the feature and not a parser worth maintaining: `term = meaning` lines
 * (also `-` or `:`), and a question about what the list holds. Anything else
 * gets one sentence saying so.
 */

import type { Profile } from '$lib/types';
import type { AssistantTurn, ChatOptions, ChatTurn } from './chat';
import { MAX_WORDS_PER_CALL, defaultToolContext, executeToolCall } from './tools';
import type { ToolOutcome } from './tools';

/** How many terms the offline reply names before trailing off. */
const PREVIEW = 3;

/** Longest term the line parser will accept, in words — a term, not a sentence. */
const MAX_TERM_WORDS = 4;

/** `hola = hello`, `hola - hello`, `hola: hello`, with an optional leading "add". */
const WORD_LINE = /^(?:add\s+)?(.+?)\s*(?:[=:]|\s-\s)\s*(.+?)\s*$/;

/** Asking about the list rather than changing it. */
const ASKS_FOR_LIST = /\b(list|show|words|vocab(?:ulary)?|know|learned)\b/i;

/** Said when the message is neither of the two things the mock understands. */
export const OFFLINE_REPLY =
	'Offline demo mode: no API key, so I only do the basics. Write "word = meaning" on a line to add words, or ask me what is in your list.';

/** The `{term, meaning}` pairs a message spells out, one per line. */
export function parseWordLines(text: string): { term: string; meaning: string }[] {
	const words: { term: string; meaning: string }[] = [];
	for (const line of text.split('\n')) {
		const match = WORD_LINE.exec(line.trim());
		if (!match) continue;
		const term = match[1].trim();
		const meaning = match[2].trim();
		if (!term || !meaning) continue;
		if (term.split(/\s+/).length > MAX_TERM_WORDS) continue;
		words.push({ term, meaning });
		if (words.length === MAX_WORDS_PER_CALL) break;
	}
	return words;
}

/** One turn, offline. Deterministic: same message, same reply, same writes. */
export async function mockChat(
	_history: ChatTurn[],
	text: string,
	_profile: Profile,
	opts: ChatOptions = {}
): Promise<AssistantTurn> {
	const ctx = defaultToolContext(opts.deps);

	const words = parseWordLines(text);
	if (words.length > 0) {
		const outcome = await executeToolCall(
			{ name: 'add_words', arguments: JSON.stringify({ words }) },
			ctx
		);
		return turn(
			`${outcome.summary}. (Offline demo mode — no model was asked.)`,
			'add_words',
			outcome
		);
	}

	if (ASKS_FOR_LIST.test(text)) {
		const outcome = await executeToolCall(
			{ name: 'list_words', arguments: JSON.stringify({ limit: PREVIEW }) },
			ctx
		);
		// The mock reads back the shape its own tool just returned.
		const listed = outcome.result as {
			total: number;
			entries: { term: string }[];
		};
		const terms = listed.entries.map((entry) => entry.term);
		const tail = listed.total > terms.length ? ', ...' : '';
		const body = terms.length
			? `Your list holds ${listed.total}: ${terms.join(', ')}${tail}.`
			: 'Your list is empty so far.';
		return turn(`${body} (Offline demo mode — no model was asked.)`, 'list_words', outcome);
	}

	return { role: 'assistant', text: OFFLINE_REPLY, actions: [] };
}

function turn(text: string, tool: string, outcome: ToolOutcome): AssistantTurn {
	return {
		role: 'assistant',
		text,
		actions: [{ tool, summary: outcome.summary, ok: outcome.ok !== false }]
	};
}
