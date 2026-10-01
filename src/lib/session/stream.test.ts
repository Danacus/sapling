/**
 * The practice stream against a real store: each pick reads what the last
 * answer wrote, a shown challenge never comes back in the same stream, match
 * rounds pace early words, and a stream with nothing left says whether writing
 * more would help. The picking itself is Rust's (`crates/sapling-challenges`'
 * `stream.rs`) and tested there.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { addToPool, getDifficultyParts, recentResults, saveProfile, upsertItems } from '$lib/db';
import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend } from '$lib/db/backend.testing';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import { applyResult } from './engine';
import { PracticeStream, shouldRefill, type StreamOutlook } from './stream';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const profile: Profile = {
	nativeLanguage: 'English',
	targetLanguage: 'Spanish',
	level: 'beginner',
	interests: [],
	model: 'mock',
	createdAt: NOW - 30 * DAY
};

function word(id: string): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term: `term-${id}`,
		meaning: `meaning-${id}`,
		introducedAt: NOW - 10 * DAY,
		fsrsCard: null,
		history: []
	};
}

/** A one-word recognition question about `itemId`: what a brand-new word fits. */
function recognition(id: string, itemId: string): Challenge {
	return {
		id,
		type: 'multiple-choice',
		direction: 'toNative',
		prompt: `p${id}`,
		options: ['a', 'b', 'c', 'd'],
		correctIndex: 0,
		itemIds: [itemId]
	};
}

/** A clock that moves a minute per read, so every answer lands at its own instant. */
function ticking() {
	let at = NOW;
	return () => (at += 60_000);
}

const device = { romanizationMode: 'adaptive' as const, audio: false };

beforeEach(async () => {
	setBackendForTesting(await makeTestBackend('stream-test', () => NOW));
	await saveProfile(profile);
});

describe('PracticeStream', () => {
	it('picks against the store, never shows a challenge twice, and learns as it goes', async () => {
		await upsertItems([word('a'), word('b')]);
		await addToPool([recognition('ca', 'a'), recognition('cb', 'b'), recognition('ca2', 'a')], NOW);
		const stream = new PracticeStream({ clock: ticking(), device });

		const shown: string[] = [];
		for (;;) {
			const step = await stream.next();
			if (step.kind === 'empty') break;
			expect(step.kind).toBe('challenge');
			if (step.kind !== 'challenge') continue;
			shown.push(step.challenge.id);
			await applyResult(step.challenge, {
				verdict: 'correct',
				answerGiven: 'a',
				shown: step.shown,
				now: NOW + shown.length * 60_000
			});
			stream.noteAnswered(step.challenge, 8_000);
		}
		expect([...shown].sort()).toEqual(['ca', 'ca2', 'cb']);
		// Every answer recorded the help level it was shown at, and the model learned from it.
		const results = await recentResults(5);
		expect(results.every((result) => result.shown === 'plain')).toBe(true);
		expect(Object.keys((await getDifficultyParts()).bases)).toContain('recognize-mc/plain');
		expect(stream.items.every((item) => item.skill !== undefined)).toBe(true);
	});

	it('puts a match round after every fourth early-word challenge, only with one to follow', async () => {
		const words = Array.from({ length: 6 }, (_, i) => word(`w${i}`));
		await upsertItems(words);
		await addToPool(
			words.map((w, i) => recognition(`c${i}`, w.id)),
			NOW
		);
		const stream = new PracticeStream({ clock: ticking(), device, seed: 1 });

		const kinds: string[] = [];
		for (;;) {
			const step = await stream.next();
			if (step.kind === 'empty') break;
			kinds.push(step.kind);
			// Unanswered in the store, so every word stays new: early material.
			stream.noteAnswered(step.challenge, 8_000);
		}
		expect(kinds).toEqual([
			'challenge',
			'challenge',
			'challenge',
			'challenge',
			'round',
			'challenge',
			'challenge'
		]);
	});

	it('says whether writing more would help once nothing fits', async () => {
		await upsertItems([word('a'), word('b')]);
		await addToPool([recognition('ca', 'a')], NOW);
		const stream = new PracticeStream({ clock: ticking(), device });

		expect((await stream.next()).kind).toBe('challenge');
		const empty = await stream.next();
		expect(empty.kind).toBe('empty');
		if (empty.kind !== 'empty') return;
		// `b` never had a challenge: a top-up has something to write.
		expect(empty.outlook.wants).toBeGreaterThan(0);
		expect(empty.outlook.ready).toBe(0);
		expect(empty.outlook.lowWater).toBeGreaterThanOrEqual(4);
	});
});

describe('shouldRefill', () => {
	const outlook = (over: Partial<StreamOutlook> = {}): StreamOutlook => ({
		ready: 2,
		upcoming: 20,
		due: 10,
		stranded: 0,
		wants: 6,
		lowWater: 5,
		...over
	});

	it('asks for a batch when the ready words fall under the mark and one can be written', () => {
		expect(shouldRefill(outlook(), { canWrite: true, writing: false })).toBe(true);
		expect(shouldRefill(outlook({ ready: 5 }), { canWrite: true, writing: false })).toBe(false);
	});

	it('asks for a stranded due word however many words ahead are ready', () => {
		const ahead = outlook({ ready: 15, stranded: 3 });
		expect(shouldRefill(ahead, { canWrite: true, writing: false })).toBe(true);
		// Once asked for three, it asks again only when a refill rescued some.
		expect(shouldRefill(ahead, { canWrite: true, writing: false, strandedMark: 3 })).toBe(false);
		expect(
			shouldRefill(outlook({ ready: 15, stranded: 2 }), {
				canWrite: true,
				writing: false,
				strandedMark: 3
			})
		).toBe(true);
	});

	it('never asks without a key or a connection, twice at once, or for nothing', () => {
		expect(shouldRefill(outlook(), { canWrite: false, writing: false })).toBe(false);
		expect(shouldRefill(outlook(), { canWrite: true, writing: true })).toBe(false);
		expect(shouldRefill(outlook({ wants: 0 }), { canWrite: true, writing: false })).toBe(false);
		const stranded = outlook({ ready: 15, stranded: 3 });
		expect(shouldRefill(stranded, { canWrite: false, writing: false })).toBe(false);
		expect(shouldRefill(stranded, { canWrite: true, writing: true })).toBe(false);
	});
});
