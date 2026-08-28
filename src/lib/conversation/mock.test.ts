/**
 * The offline path. Two things are worth pinning: it is deterministic — the
 * same history and message always produce the same reply and the same writes —
 * and its `add_words` line really goes through the production executor, so the
 * offline mode adds words the learner keeps.
 */

import { describe, expect, it } from 'vitest';

import type { ToolContext } from '$lib/assistant/tools';
import type { KnowledgeItem, Profile } from '$lib/types';
import { mockScenario, mockTurn } from './mock';
import type { ConversationTurn } from './teacher';

const NOW = 1_700_000_000_000;

const profile: Profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: [],
	model: 'test/model',
	createdAt: NOW
};

function fakeDeps(): { deps: Partial<ToolContext>; items: KnowledgeItem[] } {
	const items: KnowledgeItem[] = [];
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

/** A transcript with `n` completed learner turns. */
function history(n: number): ConversationTurn[] {
	return Array.from({ length: n }, (_, i): ConversationTurn[] => [
		{ role: 'learner', text: `turn ${i}` },
		{ role: 'teacher', reply: { text: 'ok' }, actions: [] }
	]).flat();
}

describe('mockScenario', () => {
	it('returns a teacher-first scene with an opener', async () => {
		const scene = await mockScenario({ profile });
		expect(scene.firstSpeaker).toBe('teacher');
		expect(scene.opener?.text).toBeTruthy();
		expect(scene.teacherRole).toBeTruthy();
		expect(scene.learnerRole).toBeTruthy();
	});

	it('threads the learner topic into the setting', async () => {
		const scene = await mockScenario({ profile, topic: 'ordering coffee' });
		expect(scene.setting).toContain('ordering coffee');
	});

	it('is deterministic', async () => {
		expect(await mockScenario({ profile, topic: 'football' })).toEqual(
			await mockScenario({ profile, topic: 'football' })
		);
	});
});

describe('mockTurn', () => {
	const scene = {
		setting: 's',
		teacherRole: 't',
		learnerRole: 'l',
		firstSpeaker: 'teacher' as const
	};

	it('cycles its replies by the learner turn count, and repeats exactly', async () => {
		const first = await mockTurn([], scene, 'hola', profile, { deps: fakeDeps().deps });
		const again = await mockTurn([], scene, 'hola', profile, { deps: fakeDeps().deps });
		const later = await mockTurn(history(1), scene, 'hola', profile, { deps: fakeDeps().deps });

		expect(again).toEqual(first);
		expect(later.teacher.reply.text).not.toBe(first.teacher.reply.text);
		expect(first.teacher.translation).toBeTruthy();
	});

	it('corrects one set turn and leaves the first one clean', async () => {
		const first = await mockTurn([], scene, 'quiero un helado', profile, { deps: fakeDeps().deps });
		const second = await mockTurn(history(1), scene, 'quiero un helado', profile, {
			deps: fakeDeps().deps
		});

		expect(first.correction).toBeUndefined();
		expect(second.correction?.corrected).toEqual({ text: 'Quiero un helado.' });
		expect(second.correction?.note).toBeTruthy();
	});

	it('reads one set turn back in "script", on a bubble with no correction', async () => {
		const third = await mockTurn(history(2), scene, 'quiero un helado', profile, {
			deps: fakeDeps().deps
		});

		expect(third.correction).toBeUndefined();
		expect(third.heard).toEqual({ text: 'Quiero un helado.' });
	});

	it('adds a "term = meaning" line through the real add_words executor', async () => {
		const store = fakeDeps();
		const result = await mockTurn([], scene, 'helado = ice cream', profile, { deps: store.deps });

		expect(result.teacher.actions).toEqual([
			{ tool: 'add_words', summary: 'Added 1 word: helado', ok: true }
		]);
		expect(store.items).toHaveLength(1);
		expect(store.items[0]).toMatchObject({ term: 'helado', meaning: 'ice cream', kind: 'vocab' });
		// A real card, not a placeholder: the offline path is the production path.
		expect(store.items[0].fsrsCard).toBeTruthy();
	});

	it('writes nothing when the message names no words', async () => {
		const store = fakeDeps();
		const result = await mockTurn([], scene, 'quiero un helado', profile, { deps: store.deps });

		expect(result.teacher.actions).toEqual([]);
		expect(store.items).toHaveLength(0);
	});
});
