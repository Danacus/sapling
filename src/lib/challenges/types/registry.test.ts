/**
 * Guards on the stored-type registry.
 *
 * Most of what is checked here is true by construction *today* — the registry is
 * a mapped type over `ChallengeType`, the union is projected from it, the
 * dispatchers look defs up by the challenge's own tag. The tests exist for the
 * next person: they turn "added a stored type and forgot half of it" into a red
 * suite instead of a challenge that grades wrong or renders blank, and they fail
 * loudly if anyone reintroduces a hand-written copy of a list that is currently
 * derived.
 *
 * That last one is why `challengeSchema` is imported from `$lib/llm/schemas`
 * rather than composed here: that module is the façade every other module
 * imports through, and a hand-edited union over there — a member added, one
 * dropped, the order shuffled — would be invisible to a test that read the
 * registry twice.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { challengeSchema } from '$lib/llm/schemas';
import type { Challenge, ChallengeType } from '$lib/types';
import { STORED_TYPE_DEFS, STORED_TYPE_ORDER, storedDefFor } from './index';

const TYPES_DIR = dirname(fileURLToPath(import.meta.url));

/** One source file per registered def, by its own type — not derived, since the
 * point is to catch a def whose import list drifted from what this test knows
 * about, and a derived list could drift the same way. */
const DEF_FILES: Record<ChallengeType, string> = {
	'multiple-choice': 'multiple-choice.ts',
	cloze: 'cloze.ts',
	'typed-translation': 'typed-translation.ts',
	'match-pairs': 'match-pairs.ts',
	'word-order': 'word-order.ts',
	'spot-error': 'spot-error.ts'
};

/** The `type` literal each member of the stored union pins, in union order. */
const unionTypes = (): string[] => challengeSchema.options.map((option) => option.shape.type.value);

const defs = () => STORED_TYPE_ORDER.map((type) => STORED_TYPE_DEFS[type]);

describe('STORED_TYPE_DEFS', () => {
	it('covers the stored union exactly, in the same order', () => {
		expect([...STORED_TYPE_ORDER]).toEqual(unionTypes());
	});

	it('is keyed by the type each def declares', () => {
		// The dispatchers trust this: `STORED_TYPE_DEFS[c.type]` is taken to be the
		// def *for* `c`, which is what makes the lookup sound where the compiler
		// cannot see the correlation.
		for (const [type, def] of Object.entries(STORED_TYPE_DEFS)) {
			expect(def.type).toBe(type);
		}
	});

	it('lists every registered type in the union order exactly once', () => {
		expect(new Set(STORED_TYPE_ORDER).size).toBe(STORED_TYPE_ORDER.length);
		expect([...STORED_TYPE_ORDER].sort()).toEqual(Object.keys(STORED_TYPE_DEFS).sort());
	});

	it('is the union, member for member', () => {
		// True by construction: `challengeSchema` is a projection of the registry.
		// Asserted anyway on *identity*, because the union reaches the app through
		// `$lib/llm/schemas` — if that façade is ever hand-edited into a second list
		// of members, matching type literals would not catch it but this will.
		expect([...challengeSchema.options]).toEqual(defs().map((def) => def.schema));
	});

	it('carries the schema member for its own type', () => {
		for (const def of defs()) {
			const sample = { type: def.type };
			// A bare `{type}` fails validation, but only on the *other* fields: the
			// discriminator itself must be accepted, which is what pins def→schema.
			const issues = def.schema.safeParse(sample).error?.issues ?? [];
			expect(issues.some((issue) => issue.path[0] === 'type')).toBe(false);
		}
	});
});

describe('storedDefFor', () => {
	it('returns the def whose type the challenge carries', () => {
		for (const type of STORED_TYPE_ORDER) {
			const challenge = { type } as unknown as Challenge;
			expect(storedDefFor(challenge)).toBe(STORED_TYPE_DEFS[type]);
		}
	});

	it('throws by name on a type this build has never heard of', () => {
		// A row synced down from a build that knew more types than this one: the
		// type system cannot see it coming, so the lookup has to.
		const alien = { id: 'x', type: 'dictation' } as unknown as Challenge;
		expect(() => storedDefFor(alien)).toThrow(/dictation/);
	});
});

describe('stored-type purity', () => {
	it('keys the registry with exactly the members of the ChallengeType union', () => {
		// The compile-time half of this lives in `./def` (the registry is a mapped
		// type over `ChallengeType`). This is its runtime echo, so the failure is
		// legible when someone reaches for a cast to get past the type error.
		const expected: { [T in ChallengeType]: true } = {
			'multiple-choice': true,
			cloze: true,
			'typed-translation': true,
			'match-pairs': true,
			'word-order': true,
			'spot-error': true
		};
		expect(Object.keys(STORED_TYPE_DEFS).sort()).toEqual(Object.keys(expected).sort());
	});
});

describe('difficulty', () => {
	it('gives every stored type a difficulty method at all', () => {
		// Membership only — that the number it returns is in range, moves the right
		// way with each knob and orders sensibly against the other types is
		// `../difficulty.test.ts`. What this catches is a def added without the
		// method, which would otherwise surface as a lesson whose planner
		// preference silently treats every row of that type as equally hard.
		for (const [type, def] of Object.entries(STORED_TYPE_DEFS)) {
			expect(typeof def.difficulty, type).toBe('function');
		}
	});
});

describe('stored-type def imports', () => {
	it('imports only zod, $lib/types, $lib/validate and the three shared siblings', () => {
		// `./def`'s contract: a def is a leaf, so it may reach for zod, `$lib/types`
		// and `$lib/validate` plus the shared siblings that keep that boundary from
		// bulging every time a def needs one more cross-cutting fact. Anything
		// else — `$lib/llm`, `$lib/db`, another challenge's own module — is exactly
		// the cycle `./def` warns about.
		//
		// The sibling list is spelled out rather than accepted as "anything
		// relative": a def importing another *def* (`./cloze` from `./word-order`)
		// is a def→def edge, which is the same cycle risk under a relative
		// specifier, and a blanket `./` prefix test waved it straight through.
		const allowedExternal = new Set(['zod', '$lib/types', '$lib/validate']);
		const allowedSiblings = new Set(['./def', './primitives', './word-count']);
		const importLine = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+'([^']+)';?\s*$/gm;

		for (const file of Object.values(DEF_FILES)) {
			const source = readFileSync(join(TYPES_DIR, file), 'utf8');
			for (const match of source.matchAll(importLine)) {
				const specifier = match[1];
				const allowed = allowedSiblings.has(specifier) || allowedExternal.has(specifier);
				expect(allowed, `${file} imports "${specifier}"`).toBe(true);
			}
		}
	});
});
