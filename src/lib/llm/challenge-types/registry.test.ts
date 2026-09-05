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
import type { Challenge } from '$lib/types';
import { correctiveInstructionFor, parseBatch, systemPromptFor } from '../generate';
import type { BatchArgs } from '../generate';
import { buildEscalationPrompt } from '../escalation';
import { mockBatchCompletion } from '../mock';
import { generatedChallengeSchema } from '../schemas';
import { PLANNABLE_KINDS, bareKind, kindOf } from '../requests';
import { demandOf } from '$lib/challenges/demand';
import { difficultyOf } from '$lib/challenges/difficulty';
import { FIXTURE_SCENARIOS, WIRE_TYPE_DEFS, byType, clozeDef, wordOrderDef } from './index';
import type {
	AnyWireTypeDef,
	ChallengeParams,
	DifficultyRung,
	ResolveContext,
	SizingKind,
	WireTypeDef
} from './index';

const RUNGS: DifficultyRung[] = [1, 2, 3, 4, 5];

/**
 * A def's parameters at one rung, read through the `WireTypeDef` contract.
 *
 * The defs are written with `satisfies`, which keeps each `params` at its own
 * literal type — a function of one argument returning `{words: 1 | 3 | ...}`.
 * That is what the registry wants; it is not what a test iterating over every
 * def can index by key, so this reads them as the contract declares them.
 */
const paramsOf = (
	def: AnyWireTypeDef,
	rung: DifficultyRung,
	kind: SizingKind = {}
): ChallengeParams => (def.params as WireTypeDef['params'])(rung, kind);

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
		expect([...generatedChallengeSchema.options]).toEqual(WIRE_TYPE_DEFS.map((def) => def.schema));
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

	it('declares the stored shape its own resolver actually writes', () => {
		// `stored` is what `../generate` checks a request's reply against — a
		// request for `produce-mc` is filled by a `multiple-choice` in the
		// `toTarget` direction and by nothing else — so a def whose declaration
		// drifted from its resolver would quietly reject the very challenges it
		// asked for. Every fixture is resolved and compared.
		for (const def of WIRE_TYPE_DEFS) {
			const resolve = def.resolve as (g: unknown, c: ResolveContext) => Challenge | null;
			for (const scenario of FIXTURE_SCENARIOS) {
				for (const fixture of def.fixtures[scenario]) {
					const resolved = resolve(fixture.challenge, {
						base: { id: 'c1', itemIds: ['i1'] },
						rng: () => 0.5
					});
					expect(resolved, `${def.type} fixture (${scenario}) did not resolve`).not.toBeNull();
					expect({ type: resolved?.type, direction: resolved?.direction }).toEqual(def.stored);
				}
			}
		}
	});

	it('is reachable by type', () => {
		for (const def of WIRE_TYPE_DEFS) expect(byType.get(def.type)).toBe(def);
		expect(byType.size).toBe(WIRE_TYPE_DEFS.length);
	});

	it('is plannable: every registered type is one the top-up planner can ask for', () => {
		// Type choice is the session's (`$lib/session/topup`, over `../requests`'
		// `PLANNABLE_KINDS`), so being in the registry is not enough to be
		// generated — a type no kind names is a type the model could be told
		// about, shown an example of, and never asked for.
		expect([...new Set(PLANNABLE_KINDS.map((kind) => kind.type))].sort()).toEqual(
			WIRE_TYPE_DEFS.map((def) => def.type).sort()
		);
	});

	it('states, for every plannable kind, the demand tier its resolved challenge reports', () => {
		// The session gates a want on this number — a level-1 word may only be
		// asked for demand-0 kinds — and reads a pooled row back through `kindOf`
		// to see what it already has. Both are checked against every def's own
		// fixtures, resolved for real: a kind whose stated tier drifted from its
		// resolver would have the session ask for challenges it then declines to
		// serve, or count coverage it does not have.
		for (const kind of PLANNABLE_KINDS) {
			const def = byType.get(kind.type);
			if (!def) throw new Error(`no def for ${kind.type}`);
			const resolve = def.resolve as (g: unknown, c: ResolveContext) => Challenge | null;
			let seen = 0;
			for (const scenario of FIXTURE_SCENARIOS) {
				for (const fixture of def.fixtures[scenario]) {
					const generated = fixture.challenge as { distractorWords?: unknown[] | null };
					const banked = (generated.distractorWords?.length ?? 0) > 0;
					if (kind.bank !== undefined && banked !== kind.bank) continue;
					const resolved = resolve(fixture.challenge, {
						base: { id: 'c1', itemIds: ['i1'] },
						rng: () => 0.5
					});
					if (!resolved) throw new Error(`${def.type} fixture (${scenario}) did not resolve`);
					seen++;
					expect(kindOf(resolved), `${def.type} read back`).toEqual(bareKind(kind));
					expect(demandOf(resolved), `${def.type} (bank: ${kind.bank}) demand`).toBe(kind.demand);
				}
			}
			expect(seen, `no fixture exercises ${def.type} (bank: ${kind.bank})`).toBeGreaterThan(0);
		}
	});

	it('reads a match-pairs round back as no kind at all', () => {
		// Built locally, never generated: it is not coverage of anything a top-up
		// could ask for.
		expect(
			kindOf({ id: 'm', type: 'match-pairs', direction: 'toNative', itemIds: ['i1'], pairs: [] })
		).toBeUndefined();
	});
});

describe('difficulty parameters', () => {
	// Difficulty is these numbers now. A def that forgot them would be prompted,
	// asked for and written at whatever size the model felt like.
	it('gives every def a params function and a line explaining its keys', () => {
		for (const def of WIRE_TYPE_DEFS) {
			expect(typeof def.params, def.type).toBe('function');
			expect(def.paramsSpec.length, def.type).toBeGreaterThan(0);
			const keys = Object.keys(paramsOf(def, 3));
			expect(keys.length, `${def.type} sizes itself by nothing`).toBeGreaterThan(0);
			// Every key it emits is named in the line that explains them, or the
			// model is handed a number with no idea what it counts.
			for (const key of keys) {
				expect(def.paramsSpec, `${def.type} paramsSpec omits ${key}`).toContain(key);
			}
		}
	});

	it('keeps the same keys at every rung', () => {
		for (const def of WIRE_TYPE_DEFS) {
			const shapes = RUNGS.map((rung) => Object.keys(paramsOf(def, rung, { bank: true })).sort());
			expect(new Set(shapes.map((keys) => keys.join(','))).size, def.type).toBe(1);
		}
	});

	it('is monotone in the rung: lengths never fall, a word bank never grows', () => {
		for (const def of WIRE_TYPE_DEFS) {
			for (const kind of [{}, { bank: true }, { bank: false }]) {
				const ladders = RUNGS.map((rung) => paramsOf(def, rung, kind));
				for (const key of Object.keys(ladders[0])) {
					const values = ladders.map((params) => params[key]);
					// A bank is support, so it shrinks as the rung rises; everything
					// else — words, tiles, distractors — grows.
					const rising = key === 'bank' ? [...values].reverse() : values;
					for (let i = 1; i < rising.length; i++) {
						expect(rising[i], `${def.type}.${key} at rung ${i + 1}`).toBeGreaterThanOrEqual(
							rising[i - 1]
						);
					}
				}
			}
		}
	});
});

describe('the rungs, as the stored side reads them back', () => {
	// The loop this closes: the session plans a rung, a def turns it into counts,
	// the model writes to those counts, and `$lib/challenges/difficulty` reads
	// the result back off the stored row. If the two ladders disagreed, a lesson
	// written for a strong word would be filed as easy material and the session
	// planner would serve it to a weak one.
	const resolveAs = (def: AnyWireTypeDef, generated: unknown, params: ChallengeParams) => {
		const resolve = def.resolve as (g: unknown, c: ResolveContext) => Challenge | null;
		const resolved = resolve(generated, {
			base: { id: 'c1', itemIds: ['i1'] },
			rng: () => 0.5,
			params
		});
		if (!resolved) throw new Error(`${def.type} did not resolve`);
		return resolved;
	};

	const wordsOf = (count: number) =>
		Array.from({ length: count }, (_, i) => ({ text: `w${i}`, reading: null }));

	const clozeAt = (rung: DifficultyRung) => {
		const params = paramsOf(clozeDef, rung, { bank: true });
		return resolveAs(
			clozeDef,
			{
				type: 'cloze',
				// The gap counts as one of the sentence's words.
				before: {
					text: `${wordsOf(params.words - 1)
						.map((w) => w.text)
						.join(' ')} `,
					reading: null
				},
				answer: { text: 'x', reading: null },
				after: { text: '', reading: null },
				hintNative: 'what it means',
				distractorWords: wordsOf(5).map((w) => ({ text: `d${w.text}`, reading: null })),
				itemIds: ['i1']
			},
			params
		);
	};

	const wordOrderAt = (rung: DifficultyRung) => {
		const params = paramsOf(wordOrderDef, rung);
		return resolveAs(
			wordOrderDef,
			{
				type: 'word-order',
				promptNative: 'what it means',
				words: wordsOf(params.tiles),
				distractorWords: wordsOf(3).map((w) => ({ text: `d${w.text}`, reading: null })),
				itemIds: ['i1']
			},
			params
		);
	};

	it('files a cloze written at rung 1 easier than one written at rung 5', () => {
		expect(difficultyOf(clozeAt(1))).toBeLessThan(difficultyOf(clozeAt(5)));
	});

	it('files a word-order written at rung 1 easier than one written at rung 5', () => {
		expect(difficultyOf(wordOrderAt(1))).toBeLessThan(difficultyOf(wordOrderAt(5)));
	});

	it('rises with every rung, never falling back', () => {
		for (const build of [clozeAt, wordOrderAt]) {
			const ladder = RUNGS.map((rung) => difficultyOf(build(rung)));
			for (let i = 1; i < ladder.length; i++) {
				expect(ladder[i]).toBeGreaterThanOrEqual(ladder[i - 1]);
			}
		}
	});

	it('gives the resolver the bank and tile counts it was told to expect', () => {
		// The parameters the resolver can enforce, enforced: a bank sized to the
		// rung, and a tray that stops where the plan said it should.
		const easy = clozeAt(1);
		const hard = clozeAt(5);
		expect(easy.type === 'cloze' && easy.wordBank).toHaveLength(6);
		expect(hard.type === 'cloze' && hard.wordBank).toHaveLength(3);

		const shortest = wordOrderAt(1);
		expect(shortest.type === 'word-order' && shortest.tiles).toHaveLength(3);
	});
});

describe('prompt composition', () => {
	const promptFor = (def: AnyWireTypeDef): string => systemPromptFor(def);

	it("puts each def's own spec, params and rules in its own system prompt", () => {
		for (const def of WIRE_TYPE_DEFS) {
			const prompt = promptFor(def);
			expect(prompt, `promptSpec: ${def.type}`).toContain(def.promptSpec);
			expect(prompt, `paramsSpec: ${def.type}`).toContain(def.paramsSpec);
			if (def.rulesSpec) {
				expect(prompt.split(def.rulesSpec).length - 1, `rulesSpec: ${def.type}`).toBe(1);
			}
		}
	});

	it('never names another wire type in a type’s own prompt', () => {
		// The saving that pays for the split: a request for one type carries one
		// type's field list, example and rules — not seven.
		for (const def of WIRE_TYPE_DEFS) {
			const prompt = promptFor(def);
			for (const other of WIRE_TYPE_DEFS) {
				if (other.type === def.type) continue;
				// `cloze` is a substring of nothing else, and no type name is a
				// substring of another, so a bare `includes` is exact here.
				expect(prompt, `${def.type}'s prompt mentions ${other.type}`).not.toContain(other.type);
			}
		}
	});

	it('restates only this type’s fields in its corrective instruction', () => {
		for (const def of WIRE_TYPE_DEFS) {
			const corrective = correctiveInstructionFor(def);
			expect(corrective, def.type).toContain(def.correctiveSpec);
			for (const other of WIRE_TYPE_DEFS) {
				if (other.type === def.type) continue;
				expect(corrective, `${def.type}'s retry mentions ${other.type}`).not.toContain(other.type);
			}
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
		// Two words for the scenario's own pair to be bound onto — with none, the
		// canned half has nothing to cite and resolves away. See `mock.ts`.
		wants: [
			{
				item: { id: 'i1', term: 'el perro', meaning: 'the dog' },
				kind: { type: 'recognize-mc' },
				difficulty: 1
			},
			{
				item: { id: 'i2', term: 'la canción', meaning: 'the song' },
				kind: { type: 'recognize-mc' },
				difficulty: 1
			}
		]
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
