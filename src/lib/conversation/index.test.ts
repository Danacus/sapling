/**
 * Conversation mode through the wasm build's `llm` export, in mock mode: the
 * Rust scene and turn fixtures through the Rust parsers, `add_words` writing
 * to a real in-memory store, and a mock transcript fed back as history.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { makeTestBackend, loadWasmCore } from '$lib/db/backend.testing';
import type { LearnerProfile, ToolContext } from '$lib/llm';
import { sendTurn, startConversation } from './index';
import type { ConversationTurn } from './index';

beforeAll(loadWasmCore);

const profile: LearnerProfile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish'
};

describe('startConversation', () => {
	it('returns a teacher-first scene with its opener and the topic', async () => {
		const scene = await startConversation({ profile, wordCount: 0, topic: 'helados' });
		expect(scene.firstSpeaker).toBe('teacher');
		expect(scene.opener?.text).toBeTruthy();
		expect(scene.openerTranslation).toBeTruthy();
		expect(scene.setting).toContain('helados');
	});
});

describe('sendTurn', () => {
	it('files words, then corrects the second message and hears the third', async () => {
		const backend = await makeTestBackend();
		const tools: ToolContext = {
			getAllItems: () => backend.getAllItems(),
			upsertItems: (items) => backend.upsertItems(items),
			deleteItem: (id) => backend.deleteItem(id),
			newId: () => crypto.randomUUID(),
			now: () => Date.now()
		};
		const scene = await startConversation({ profile, wordCount: 0 });
		const turns: ConversationTurn[] = [];

		for (const text of ['helado = ice cream', 'un helado', 'agua']) {
			const result = await sendTurn(turns, scene, text, profile, { tools });
			turns.push(
				{
					role: 'learner',
					text,
					...(result.heard ? { heard: result.heard } : {}),
					...(result.correction ? { correction: result.correction } : {})
				},
				result.teacher
			);
		}

		const [first, , second, , third] = turns;
		expect(turns[1]).toMatchObject({ role: 'teacher', actions: [{ tool: 'add_words', ok: true }] });
		expect((await backend.getAllItems()).map((item) => item.term)).toEqual(['helado']);
		expect(first).toEqual({ role: 'learner', text: 'helado = ice cream' });
		expect(second).toMatchObject({ correction: { corrected: { text: 'Un helado.' } } });
		expect(third).toMatchObject({ heard: { text: 'Agua.' } });
		expect(third).not.toHaveProperty('correction');
	});
});
