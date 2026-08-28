/**
 * The setup call: what the model is told, and what the app is willing to accept
 * back. The scene is the one thing conversation mode cannot degrade — without
 * roles there is nothing to play — so the parser is tested for refusing as much
 * as for accepting.
 */

import { describe, expect, it } from 'vitest';

import { LlmError } from '$lib/llm';
import type { Profile } from '$lib/types';
import { buildScenarioPrompt, parseScenario } from './scenario';
import { scenarioJsonSchema } from './schemas';

const profile: Profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Dutch',
	level: 'beginner',
	interests: [],
	model: 'test/model',
	createdAt: 1_700_000_000_000
};

function scenarioJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		setting: 'An ice cream shop on a hot afternoon.',
		teacherRole: 'the person behind the counter',
		learnerRole: 'a customer',
		firstSpeaker: 'teacher',
		opener: { text: 'Wat mag het zijn?', reading: null },
		...overrides
	});
}

describe('buildScenarioPrompt', () => {
	it('names both languages and the level', () => {
		const [system] = buildScenarioPrompt({ profile });
		expect(system.content).toContain('Dutch');
		expect(system.content).toContain('English');
		expect(system.content).toContain('beginner');
	});

	it('passes the learner topic through, and says so when there is none', () => {
		const withTopic = buildScenarioPrompt({ profile, topic: '  ordering coffee  ' });
		expect(withTopic[1].content).toContain('ordering coffee');

		const without = buildScenarioPrompt({ profile, topic: '   ' });
		expect(without[1].content).toContain('did not name a topic');
	});

	it('caps a topic long enough to be a prompt of its own', () => {
		const [, user] = buildScenarioPrompt({ profile, topic: 'x'.repeat(500) });
		expect(user.content.length).toBeLessThan(200);
	});
});

describe('scenarioJsonSchema', () => {
	it('lists every property as required, as strict structured outputs want', () => {
		const schema = scenarioJsonSchema();
		expect(schema.required).toEqual([
			'setting',
			'teacherRole',
			'learnerRole',
			'firstSpeaker',
			'opener'
		]);
		expect(schema.additionalProperties).toBe(false);
	});
});

describe('parseScenario', () => {
	it('reads a teacher-first scene with its opener', () => {
		expect(parseScenario(scenarioJson())).toEqual({
			setting: 'An ice cream shop on a hot afternoon.',
			teacherRole: 'the person behind the counter',
			learnerRole: 'a customer',
			firstSpeaker: 'teacher',
			opener: { text: 'Wat mag het zijn?' }
		});
	});

	it('keeps a reading when the target language has one', () => {
		const parsed = parseScenario(
			scenarioJson({ opener: { text: '你要什么？', reading: 'nǐ yào shénme' } })
		);
		expect(parsed.opener).toEqual({ text: '你要什么？', reading: 'nǐ yào shénme' });
	});

	it('normalizes a null opener to a learner-first scene', () => {
		const parsed = parseScenario(scenarioJson({ firstSpeaker: 'learner', opener: null }));
		expect(parsed.firstSpeaker).toBe('learner');
		expect(parsed.opener).toBeUndefined();
	});

	it('falls back to learner-first when the teacher claims to speak but says nothing', () => {
		const parsed = parseScenario(scenarioJson({ firstSpeaker: 'teacher', opener: null }));
		expect(parsed.firstSpeaker).toBe('learner');
		expect(parsed.opener).toBeUndefined();
	});

	it('drops an opener that would jump the learner queue', () => {
		const parsed = parseScenario(scenarioJson({ firstSpeaker: 'learner' }));
		expect(parsed.opener).toBeUndefined();
	});

	it('reads through markdown fences and chatter', () => {
		const raw = `Sure!\n\`\`\`json\n${scenarioJson()}\n\`\`\``;
		expect(parseScenario(raw).teacherRole).toBe('the person behind the counter');
	});

	it('refuses a reply that is not JSON', () => {
		expect(() => parseScenario('Let us talk about coffee!')).toThrow(LlmError);
	});

	it('refuses a scene missing a role', () => {
		expect(() => parseScenario(scenarioJson({ learnerRole: '' }))).toThrow(LlmError);
	});
});
