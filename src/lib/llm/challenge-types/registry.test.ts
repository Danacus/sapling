/**
 * Guards on the wire-type registry.
 *
 * Most of what is checked here is true by construction *today* — the prompt is
 * composed from the defs, the union is projected from them, the mock lesson is
 * assembled out of their fixtures. The tests exist for the next person: they
 * turn "added a wire type and forgot half of it" into a red suite instead of a
 * batch that silently never generates the new type, and they fail loudly if
 * anyone reintroduces a hand-written copy of a list that is currently derived.
 *
 * That last one is why the union is imported from `../schemas` rather than from
 * `./index`: `../schemas` is the façade every other module imports through, and
 * a hand-edited union over there — a member added, one dropped, the order
 * shuffled — would be invisible to a test that read the registry twice.
 */

import { describe, expect, it } from 'vitest';
import { CORRECTIVE_INSTRUCTION, buildBatchPrompt, parseBatch } from '../generate';
import type { BatchArgs } from '../generate';
import { buildEscalationPrompt } from '../escalation';
import { mockBatchCompletion } from '../mock';
import { generatedChallengeSchema } from '../schemas';
import { FIXTURE_SCENARIOS, WIRE_TYPE_DEFS, byType } from './index';

const systemPrompt = (): string => {
	const [system] = buildBatchPrompt({
		profile: {
			nativeLanguage: 'English',
			targetLanguage: 'Spanish',
			level: 'beginner',
			interests: []
		},
		reviewItems: [],
		newItemSlots: 0
	});
	return system.content;
};

/** The `type` literal each member of the generated union pins, in union order. */
const unionTypes = (): string[] =>
	generatedChallengeSchema.options.map((option) => option.shape.type.value);

describe('WIRE_TYPE_DEFS', () => {
	it('covers the generated union exactly, in the same order', () => {
		expect(WIRE_TYPE_DEFS.map((def) => def.type)).toEqual(unionTypes());
	});

	it('is the union, member for member', () => {
		// True by construction: `generatedChallengeSchema` is a projection of the
		// registry. Asserted anyway on *identity*, because the union reaches the
		// app through `../schemas` — if that façade is ever hand-edited into a
		// second list of members, matching type literals would not catch it but
		// this will.
		expect([...generatedChallengeSchema.options]).toEqual(
			WIRE_TYPE_DEFS.map((def) => def.schema)
		);
	});

	it('carries the schema member for its own type', () => {
		for (const def of WIRE_TYPE_DEFS) {
			const sample = { type: def.type };
			// A bare `{type}` fails validation, but only on the *other* fields: the
			// discriminator itself must be accepted, which is what pins def→schema.
			const issues = def.schema.safeParse(sample).error?.issues ?? [];
			expect(issues.some((issue) => issue.path[0] === 'type')).toBe(false);
		}
	});

	it('is reachable by type', () => {
		for (const def of WIRE_TYPE_DEFS) expect(byType.get(def.type)).toBe(def);
		expect(byType.size).toBe(WIRE_TYPE_DEFS.length);
	});
});

describe('prompt composition', () => {
	it('lists every def in the system prompt, in registry order', () => {
		const prompt = systemPrompt();
		let cursor = prompt.indexOf('Types:');
		expect(cursor).toBeGreaterThanOrEqual(0);
		for (const def of WIRE_TYPE_DEFS) {
			const at = prompt.indexOf(def.promptSpec, cursor);
			expect(at, `promptSpec missing or out of order: ${def.type}`).toBeGreaterThan(cursor);
			cursor = at;
		}
	});

	it('includes every rulesSpec exactly once', () => {
		const prompt = systemPrompt();
		for (const def of WIRE_TYPE_DEFS) {
			if (!def.rulesSpec) continue;
			expect(prompt.split(def.rulesSpec).length - 1, `rulesSpec: ${def.type}`).toBe(1);
		}
	});

	it('lists every def in the corrective instruction, in registry order', () => {
		let cursor = -1;
		for (const def of WIRE_TYPE_DEFS) {
			const at = CORRECTIVE_INSTRUCTION.indexOf(def.correctiveSpec, cursor + 1);
			expect(at, `correctiveSpec missing or out of order: ${def.type}`).toBeGreaterThan(cursor);
			cursor = at;
		}
	});

	it('glosses every escalationSpec in the escalation prompt, in registry order', () => {
		const [system] = buildEscalationPrompt({
			challenge: {
				id: 'c1',
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'the dog',
				acceptedAnswers: ['el perro'],
				itemIds: ['i1']
			},
			answerGiven: 'el pero',
			verdict: 'wrong',
			nativeLanguage: 'English',
			targetLanguage: 'Spanish'
		});
		let cursor = -1;
		for (const def of WIRE_TYPE_DEFS) {
			if (!def.escalationSpec) continue;
			const at = system.content.indexOf(def.escalationSpec, cursor + 1);
			expect(at, `escalationSpec missing or out of order: ${def.type}`).toBeGreaterThan(cursor);
			cursor = at;
		}
	});
});

describe('mock coverage', () => {
	const args = (targetLanguage: string): BatchArgs => ({
		profile: { nativeLanguage: 'English', targetLanguage, level: 'beginner', interests: [] },
		reviewItems: [{ id: 'i1', term: 'el perro', meaning: 'the dog' }],
		newItemSlots: 2
	});

	it('gives every def an example in every scenario', () => {
		// The mock lesson is assembled from these, so this is what makes the
		// coverage below automatic: a def with no fixture is a wire type practice
		// mode never shows and no test ever resolves.
		for (const def of WIRE_TYPE_DEFS) {
			for (const scenario of FIXTURE_SCENARIOS) {
				expect(
					def.fixtures[scenario].length,
					`no ${scenario} fixture: ${def.type}`
				).toBeGreaterThan(0);
			}
		}
	});

	it('tags every fixture with its own place in the lesson', () => {
		// `order` is what puts the assembled batch back into lesson order; two
		// fixtures claiming one slot would make the mock's shuffle sequence — and
		// so every seeded expectation in `../mock.test.ts` — depend on registry
		// order instead.
		for (const scenario of FIXTURE_SCENARIOS) {
			const orders = WIRE_TYPE_DEFS.flatMap((def) =>
				def.fixtures[scenario].map((fixture) => fixture.order)
			);
			expect(new Set(orders).size, `duplicate order in ${scenario}`).toBe(orders.length);
		}
	});

	it('exercises every wire type across the fixture sets', () => {
		const seen = new Set<string>();
		for (const language of ['Spanish', 'Chinese']) {
			for (const challenge of parseBatch(mockBatchCompletion(args(language))).challenges) {
				seen.add(challenge.type);
			}
		}
		expect([...seen].sort()).toEqual(WIRE_TYPE_DEFS.map((def) => def.type).sort());
	});
});
