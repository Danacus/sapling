/**
 * Guards on the stored-type registry: keyed by the type each def declares,
 * reached by the challenge's own tag, loud about a type this build does not
 * know, and made of leaves.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Challenge, ChallengeType } from '$lib/types';
import { STORED_TYPE_DEFS, storedDefFor } from './index';

const TYPES_DIR = dirname(fileURLToPath(import.meta.url));

/** Not derived: a derived list could drift the same way the defs do. */
const DEF_FILES: Record<ChallengeType, string> = {
	'multiple-choice': 'multiple-choice.ts',
	cloze: 'cloze.ts',
	'typed-translation': 'typed-translation.ts',
	'match-pairs': 'match-pairs.ts',
	'multi-cloze': 'multi-cloze.ts',
	'word-order': 'word-order.ts',
	'spot-error': 'spot-error.ts'
};

describe('STORED_TYPE_DEFS', () => {
	it('is keyed by the type each def declares', () => {
		for (const [type, def] of Object.entries(STORED_TYPE_DEFS)) {
			expect(def.type).toBe(type);
		}
		expect(Object.keys(STORED_TYPE_DEFS).sort()).toEqual(Object.keys(DEF_FILES).sort());
	});
});

describe('storedDefFor', () => {
	it('returns the def whose type the challenge carries', () => {
		for (const type of Object.keys(DEF_FILES) as ChallengeType[]) {
			const challenge = { type } as unknown as Challenge;
			expect(storedDefFor(challenge)).toBe(STORED_TYPE_DEFS[type]);
		}
	});

	it('throws by name on a type this build has never heard of', () => {
		const alien = { id: 'x', type: 'dictation' } as unknown as Challenge;
		expect(() => storedDefFor(alien)).toThrow(/dictation/);
	});
});

describe('stored-type def imports', () => {
	it('imports only $lib/types and ./def', () => {
		const allowed = new Set(['$lib/types', './def']);
		const importLine = /^import\s+(?:type\s+)?[\s\S]*?\s+from\s+'([^']+)';?\s*$/gm;
		for (const file of Object.values(DEF_FILES)) {
			const source = readFileSync(join(TYPES_DIR, file), 'utf8');
			for (const match of source.matchAll(importLine)) {
				expect(allowed.has(match[1]), `${file} imports "${match[1]}"`).toBe(true);
			}
		}
	});
});
