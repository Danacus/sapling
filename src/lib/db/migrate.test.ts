/**
 * The v1-queue → v2-pool row conversion.
 *
 * The Dexie `upgrade` hook around it cannot run in node (no IndexedDB), so this
 * is the half that carries the decisions and this is where they are pinned.
 */

import { describe, expect, it } from 'vitest';

import type { ChallengeRow } from './database';
import { poolRowFromLegacy, type LegacyChallengeRow } from './migrate';

const ENQUEUED_AT = 1_700_000_000_000;

function legacy(overrides: Partial<LegacyChallengeRow> = {}): LegacyChallengeRow {
	return {
		id: 'c1',
		type: 'cloze',
		direction: 'toTarget',
		sentence: 'Yo ___ un libro.',
		acceptedAnswers: ['leo'],
		translationHint: 'I read a book.',
		itemIds: ['i1'],
		status: 'queued',
		enqueuedAt: ENQUEUED_AT,
		...overrides
	} as LegacyChallengeRow;
}

describe('poolRowFromLegacy', () => {
	it('turns a queued row into a never-served pool row', () => {
		const row = poolRowFromLegacy(legacy());

		expect(row.generatedAt).toBe(ENQUEUED_AT);
		expect(row.timesServed).toBe(0);
		expect(row.lastServedAt).toBeNull();
		expect(row.reported).toBe(false);
	});

	it('turns a done row into one served at its generation time', () => {
		const row = poolRowFromLegacy(legacy({ status: 'done' }));

		expect(row.generatedAt).toBe(ENQUEUED_AT);
		expect(row.timesServed).toBe(1);
		// Deliberately the earliest time it *could* have been served: an
		// under-estimate makes old answered rows eligible again sooner, which is
		// right for a database whose newest row predates the rework.
		expect(row.lastServedAt).toBe(ENQUEUED_AT);
	});

	it('drops the queue bookkeeping and keeps the challenge intact', () => {
		const row = poolRowFromLegacy(legacy({ status: 'done' }));

		expect(row).not.toHaveProperty('status');
		expect(row).not.toHaveProperty('enqueuedAt');
		expect(row.type).toBe('cloze');
		expect(row.itemIds).toEqual(['i1']);
		// The `type` discriminant still narrows after the conversion.
		if (row.type === 'cloze') expect(row.acceptedAnswers).toEqual(['leo']);
	});

	it('is idempotent: a row already in pool shape is handed back untouched', () => {
		const pooled: ChallengeRow = {
			...poolRowFromLegacy(legacy({ status: 'done' })),
			timesServed: 4,
			lastServedAt: ENQUEUED_AT + 5000
		};

		expect(poolRowFromLegacy(pooled)).toBe(pooled);
	});
});
