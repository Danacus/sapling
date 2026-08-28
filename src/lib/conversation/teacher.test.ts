/**
 * The turn loop, driven against a fake OpenRouter.
 *
 * What matters is the exchange rather than the prose: that the one tool is
 * offered and its result fed back under the id the model used, that a correction
 * comes back beside the teacher's turn rather than on it, that history replays
 * as dialogue and never as the corrected version of what the learner wrote, and
 * that the loop always terminates — on a reply, on a failed call, or on the
 * round cap.
 *
 * Node has no API key, so `sendTurn` would dispatch to the offline mock; these
 * tests call {@link runTurn} directly with an injected key, fetch and tool
 * context, which is the path production takes.
 */

import { describe, expect, it } from 'vitest';

import type { FetchLike } from '$lib/llm';
import type { ToolContext } from '$lib/assistant/tools';
import type { KnowledgeItem, Profile } from '$lib/types';
import type { Scenario } from './schemas';
import {
	MAX_CONTEXT_WORDS,
	MAX_TOOL_ROUNDS,
	ROUND_LIMIT_REPLY,
	buildSystemPrompt,
	buildWordBlock,
	parseTeacherReply,
	runTurn
} from './teacher';
import type { ConversationTurn } from './teacher';

const NOW = 1_700_000_000_000;

const profile: Profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Dutch',
	level: 'beginner',
	interests: [],
	model: 'test/model',
	createdAt: NOW
};

const scenario: Scenario = {
	setting: 'An ice cream shop on a hot afternoon.',
	teacherRole: 'the person behind the counter',
	learnerRole: 'a customer',
	firstSpeaker: 'teacher',
	opener: { text: 'Wat mag het zijn?' }
};

interface WireMessage {
	role: string;
	content: string;
	tool_call_id?: string;
	tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

interface Call {
	messages: WireMessage[];
	tools?: { function: { name: string } }[];
	response_format?: { json_schema?: { name?: string } };
}

/** Replies with the queued completions in order, repeating the last one. */
function fakeOpenRouter(payloads: unknown[]): { fetchFn: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	let n = 0;
	const fetchFn: FetchLike = async (_url, init) => {
		calls.push(JSON.parse(String(init?.body ?? '{}')) as Call);
		const payload = payloads[Math.min(n++, payloads.length - 1)];
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});
	};
	return { fetchFn, calls };
}

function saying(content: unknown) {
	return {
		model: 'test/model',
		choices: [
			{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }
		],
		usage: { prompt_tokens: 10, completion_tokens: 5 }
	};
}

function calling(name: string, args: string, id = 'call-1') {
	return {
		model: 'test/model',
		choices: [
			{
				message: {
					content: '',
					tool_calls: [{ id, type: 'function', function: { name, arguments: args } }]
				}
			}
		],
		usage: { prompt_tokens: 10, completion_tokens: 5 }
	};
}

function fakeDeps(seed: KnowledgeItem[] = []): {
	deps: Partial<ToolContext>;
	items: KnowledgeItem[];
} {
	const items = [...seed];
	let minted = 0;
	return {
		items,
		deps: {
			getAllItems: async () => [...items],
			upsertItems: async (rows) => {
				for (const row of rows) items.push(row);
			},
			newId: () => `new-${++minted}`,
			now: () => NOW
		}
	};
}

function word(term: string, at = NOW, romanization?: string): KnowledgeItem {
	return {
		id: `seed-${term}`,
		kind: 'vocab',
		term,
		meaning: `${term}-meaning`,
		...(romanization ? { romanization } : {}),
		fsrsCard: {},
		introducedAt: at,
		history: []
	};
}

describe('buildWordBlock', () => {
	it('writes one compact line per word, with the reading when there is one', () => {
		expect(buildWordBlock([word('ijsje'), word('hallo', NOW, 'ha-lo')])).toBe(
			'ijsje = ijsje-meaning\nhallo (ha-lo) = hallo-meaning'
		);
	});

	it('keeps the most recently introduced words when the list is over the cap', () => {
		const items = Array.from({ length: MAX_CONTEXT_WORDS + 20 }, (_, i) => word(`w${i}`, NOW + i));
		const lines = buildWordBlock(items).split('\n');
		expect(lines).toHaveLength(MAX_CONTEXT_WORDS);
		expect(lines[0]).toContain(`w${items.length - 1} =`);
		expect(buildWordBlock(items)).not.toContain('w0 =');
	});

	it('is empty for an empty list', () => {
		expect(buildWordBlock([])).toBe('');
	});
});

describe('buildSystemPrompt', () => {
	it('states the scene and both roles', () => {
		const prompt = buildSystemPrompt(profile, scenario, []);
		expect(prompt).toContain('An ice cream shop on a hot afternoon.');
		expect(prompt).toContain('the person behind the counter');
		expect(prompt).toContain('a customer');
		expect(prompt).toContain('Dutch');
	});

	it('puts the word block last, so the cacheable prefix stays stable', () => {
		const withWords = buildSystemPrompt(profile, scenario, [word('ijsje')]);
		const withMore = buildSystemPrompt(profile, scenario, [word('ijsje'), word('hallo')]);
		const prefix = withWords.slice(0, withWords.indexOf('Words the learner'));
		expect(withMore.startsWith(prefix)).toBe(true);
		expect(withWords.endsWith('ijsje = ijsje-meaning')).toBe(true);
	});

	it('says so plainly when the list is empty', () => {
		expect(buildSystemPrompt(profile, scenario, [])).toContain('no words in their list yet');
	});

	it('caps the reply length by level', () => {
		const beginner = buildSystemPrompt(profile, scenario, []);
		const advanced = buildSystemPrompt({ ...profile, level: 'advanced' }, scenario, []);
		expect(beginner).toContain('one short sentence, then one short question');
		expect(advanced).toContain('two or three sentences');
		expect(advanced).not.toContain('No more than that.');
	});

	it('tells the teacher that romanized input is not a mistake', () => {
		const prompt = buildSystemPrompt(profile, scenario, []);
		expect(prompt).toContain('romanization is normal input');
		expect(prompt).toContain('ask them to say it another way');
	});

	it('keeps the correction to the learner’s own sentence', () => {
		const prompt = buildSystemPrompt(profile, scenario, []);
		expect(prompt).toContain("the learner's last message only");
		expect(prompt).toContain('never the line you just spoke');
	});
});

describe('parseTeacherReply', () => {
	it('reads a full envelope', () => {
		const raw = JSON.stringify({
			reply: { text: 'Wat mag het zijn?', reading: null },
			translation: 'What can I get you?',
			correction: { corrected: { text: 'goedenavond' }, note: 'One word.' }
		});
		expect(parseTeacherReply(raw)).toEqual({
			reply: { text: 'Wat mag het zijn?' },
			translation: 'What can I get you?',
			correction: { corrected: { text: 'goedenavond' }, note: 'One word.' }
		});
	});

	it('normalizes nullish optionals to absent', () => {
		const raw = JSON.stringify({
			reply: { text: 'Prima.' },
			translation: null,
			correction: { corrected: { text: 'goedenavond' }, note: null }
		});
		expect(parseTeacherReply(raw)).toEqual({
			reply: { text: 'Prima.' },
			correction: { corrected: { text: 'goedenavond' } }
		});
	});

	it('keeps a reading for a non-Latin script', () => {
		const raw = JSON.stringify({ reply: { text: '你要什么？', reading: 'nǐ yào shénme' } });
		expect(parseTeacherReply(raw).reply).toEqual({ text: '你要什么？', reading: 'nǐ yào shénme' });
	});

	it('reads through markdown fences', () => {
		const raw = '```json\n{"reply":{"text":"Prima."}}\n```';
		expect(parseTeacherReply(raw).reply.text).toBe('Prima.');
	});

	it('treats prose as the spoken line rather than an error', () => {
		expect(parseTeacherReply('  Prima, en verder?  ')).toEqual({
			reply: { text: 'Prima, en verder?' }
		});
	});

	it('salvages the line from JSON that missed the envelope', () => {
		expect(parseTeacherReply('{"reply":"Prima, en verder?"}')).toEqual({
			reply: { text: 'Prima, en verder?' }
		});
		expect(parseTeacherReply('{"reply":{"text":"Prima."},"correction":"nonsense"}')).toEqual({
			reply: { text: 'Prima.' }
		});
	});

	it('never shows the learner an envelope it could not read', () => {
		expect(parseTeacherReply('{"line":"Prima.","meta":{}}')).toEqual({
			reply: { text: ROUND_LIMIT_REPLY }
		});
	});

	it('never reads a broken envelope out as dialogue', () => {
		const cut = '{"reply":{"text":"Prima, en verder?","reading":null},"translation":"Fine, an';
		expect(parseTeacherReply(cut)).toEqual({ reply: { text: ROUND_LIMIT_REPLY } });
	});

	it('keeps prose that happens to contain braces', () => {
		expect(parseTeacherReply('Wat kost {dit} hier?')).toEqual({
			reply: { text: 'Wat kost {dit} hier?' }
		});
	});
});

describe('runTurn', () => {
	it('pins the envelope, offers only add_words, and returns the parsed turn', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			saying({ reply: { text: 'Prima.' }, translation: 'Fine.' })
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'ik wil een ijsje', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(result).toEqual({
			teacher: { role: 'teacher', reply: { text: 'Prima.' }, translation: 'Fine.', actions: [] }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].tools?.map((tool) => tool.function.name)).toEqual(['add_words']);
		expect(calls[0].response_format?.json_schema?.name).toBe('teacher_turn');
	});

	it('replays history as dialogue, never the corrected version', async () => {
		const { fetchFn, calls } = fakeOpenRouter([saying({ reply: { text: 'Prima.' } })]);
		const store = fakeDeps([word('ijsje')]);

		const history: ConversationTurn[] = [
			{ role: 'teacher', reply: { text: 'Wat mag het zijn?' }, translation: 'What?', actions: [] },
			{
				role: 'learner',
				text: 'ik wilt een ijsje',
				correction: { corrected: { text: 'ik wil een ijsje' } }
			}
		];

		await runTurn(history, scenario, 'en een koffie', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		const [system, ...rest] = calls[0].messages;
		expect(system.role).toBe('system');
		expect(rest).toEqual([
			{ role: 'assistant', content: 'Wat mag het zijn?' },
			{ role: 'user', content: 'ik wilt een ijsje' },
			{ role: 'user', content: 'en een koffie' }
		]);
	});

	it('returns the correction beside the turn, not on it', async () => {
		const { fetchFn } = fakeOpenRouter([
			saying({
				reply: { text: 'Prima.' },
				correction: { corrected: { text: 'ik wil een ijsje' }, note: 'Not "wilt".' }
			})
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'ik wilt een ijsje', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(result.correction).toEqual({
			corrected: { text: 'ik wil een ijsje' },
			note: 'Not "wilt".'
		});
		expect('correction' in result.teacher).toBe(false);
	});

	it('drops a correction that rewrote nothing', async () => {
		const { fetchFn } = fakeOpenRouter([
			saying({ reply: { text: 'Prima.' }, correction: { corrected: { text: 'ik wil een ijsje' } } })
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, '  ik wil een ijsje ', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(result.correction).toBeUndefined();
	});

	it('drops a correction that only respaced or re-toned what they typed', async () => {
		const { fetchFn } = fakeOpenRouter([
			saying({
				reply: { text: 'Prima.' },
				correction: { corrected: { text: '我要咖啡', reading: 'wǒ yào kā fēi' } }
			})
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'wo yao kafei', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(result.correction).toBeUndefined();
	});

	it('runs an add_words call and feeds its result back under the same id', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			calling('add_words', '{"words":[{"term":"ijsje","meaning":"ice cream"}]}'),
			saying({ reply: { text: 'Prima.' } })
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'ik wil een ijsje', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(result.teacher.actions).toEqual([
			{ tool: 'add_words', summary: 'Added 1 word: ijsje', ok: true }
		]);
		expect(store.items.map((row) => row.term)).toEqual(['ijsje']);

		const second = calls[1].messages;
		const toolMessage = second[second.length - 1];
		expect(toolMessage.role).toBe('tool');
		expect(toolMessage.tool_call_id).toBe('call-1');
		expect(JSON.parse(toolMessage.content)).toEqual({ added: ['ijsje'], skipped: [] });
	});

	it('feeds a failed call back as data and still finishes the turn', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			calling('add_words', '{"words":[]}'),
			saying({ reply: { text: 'Prima.' } })
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'ik wil een ijsje', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(result.teacher.reply.text).toBe('Prima.');
		expect(result.teacher.actions[0].ok).toBe(false);
		expect(store.items).toHaveLength(0);

		const toolMessage = calls[1].messages[calls[1].messages.length - 1];
		expect(JSON.parse(toolMessage.content)).toHaveProperty('error');
	});

	it('asks the last round without tools, so a tool call cannot eat the turn', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			calling('add_words', '{"words":[{"term":"ijsje","meaning":"ice cream"}]}', 'call-a'),
			saying({ reply: { text: 'Prima.' } })
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'ik wil een ijsje', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(calls[0].tools?.map((tool) => tool.function.name)).toEqual(['add_words']);
		expect(calls[MAX_TOOL_ROUNDS - 1].tools).toBeUndefined();
		expect(result.teacher.reply.text).toBe('Prima.');
		expect(store.items.map((row) => row.term)).toEqual(['ijsje']);
	});

	it('still pauses rather than inventing a line if a model calls a tool it was not offered', async () => {
		const { fetchFn, calls } = fakeOpenRouter([
			calling('add_words', '{"words":[{"term":"ijsje","meaning":"ice cream"}]}', 'call-a'),
			calling('add_words', '{"words":[{"term":"koffie","meaning":"coffee"}]}', 'call-b')
		]);
		const store = fakeDeps();

		const result = await runTurn([], scenario, 'ik wil een ijsje', profile, {
			apiKey: 'test',
			fetchFn,
			deps: store.deps
		});

		expect(calls).toHaveLength(MAX_TOOL_ROUNDS);
		expect(result.teacher.reply.text).toBe(ROUND_LIMIT_REPLY);
		expect(store.items.map((row) => row.term)).toEqual(['ijsje', 'koffie']);
	});
});
