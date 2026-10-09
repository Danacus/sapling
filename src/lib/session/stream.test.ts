/**
 * The practice stream against a real store: each pick reads what the last
 * answer wrote, a shown challenge never comes back in the same stream, match
 * rounds pace early words, a head with nothing waits and says what a refill
 * would write for, and is passed only when the caller says no batch can help. The picking itself is Rust's (`crates/sapling-challenges`'
 * `stream.rs`) and tested there.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { addToPool, getDifficultyParts, recentResults, saveProfile, upsertItems } from '$lib/db';
import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend } from '$lib/db/backend.testing';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import { applyResult } from './engine';
import { PracticeStream } from './stream';

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
			if (step.kind === 'blocked') break;
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
		// Unanswered in the store, so every word stays new and `w0` stays first.
		const words = Array.from({ length: 3 }, (_, i) => word(`w${i}`));
		await upsertItems(words);
		await addToPool(
			Array.from({ length: 6 }, (_, i) => recognition(`c${i}`, 'w0')),
			NOW
		);
		const stream = new PracticeStream({ clock: ticking(), device, seed: 1 });

		const kinds: string[] = [];
		for (;;) {
			const step = await stream.next();
			if (step.kind === 'blocked') break;
			kinds.push(step.kind);
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

	it('waits on its most urgent word, and claims a refill for it once', async () => {
		await upsertItems([word('a'), word('b')]);
		await addToPool([recognition('ca', 'a')], NOW);
		const stream = new PracticeStream({ clock: ticking(), device });

		const first = await stream.next();
		expect(first.kind).toBe('challenge');
		if (first.kind !== 'challenge') return;
		await applyResult(first.challenge, { verdict: 'correct', answerGiven: 'a', now: NOW });
		// `b` never had a challenge: the stream waits on it rather than reviewing `a` ahead.
		expect(await stream.next()).toEqual({ kind: 'blocked', asked: false });
		const claim = await stream.refill();
		expect(claim?.scope).toMatchObject({ served: ['ca'], asked: [] });
		expect(claim?.scope.limit).toBeGreaterThanOrEqual(4);
		expect(claim?.words).toEqual(['b', 'a']);
		// Both words ahead are asked for now, so a second claim has nothing to ask.
		expect(await stream.next()).toEqual({ kind: 'blocked', asked: true });
		expect(await stream.refill()).toBeNull();

		await addToPool([recognition('cb', 'b')], NOW);
		const next = await stream.next();
		expect(next.kind === 'challenge' && next.challenge.id).toBe('cb');
	});

	it('ends on a head already asked for whose rows came back not fitting, until a retry', async () => {
		await upsertItems([word('b')]);
		const stream = new PracticeStream({ clock: ticking(), device });
		expect(await stream.refill()).not.toBeNull();
		// What came back is a typed cloze, far too hard for a new word.
		await addToPool(
			[
				{
					id: 'typed',
					type: 'cloze',
					direction: 'toTarget',
					sentence: 'Yo ___ ayer.',
					acceptedAnswers: ['corrí'],
					itemIds: ['b']
				}
			],
			NOW
		);
		expect(await stream.next()).toEqual({ kind: 'blocked', asked: true });
		expect(await stream.refill()).toBeNull();
		stream.resetAsked();
		expect(await stream.next()).toEqual({ kind: 'blocked', asked: false });
		expect(await stream.refill()).not.toBeNull();
	});

	it('gives a failed refill’s words back, so they can be asked for again', async () => {
		await upsertItems([word('b')]);
		const stream = new PracticeStream({ clock: ticking(), device });
		const claim = await stream.refill();
		expect(claim?.words).toEqual(['b']);
		expect(await stream.next()).toEqual({ kind: 'blocked', asked: true });
		stream.release(claim?.words ?? []);
		expect(await stream.next()).toEqual({ kind: 'blocked', asked: false });
		expect(await stream.refill()).not.toBeNull();
	});

	it('passes a head no batch can help for the next word with something, and only then', async () => {
		await upsertItems([word('a'), word('b'), word('c')]);
		await addToPool([recognition('cc', 'c')], NOW);
		const stream = new PracticeStream({ clock: ticking(), device });

		expect(await stream.next()).toEqual({ kind: 'blocked', asked: false });
		const passed = await stream.next({ pass: true });
		expect(passed.kind === 'challenge' && [passed.challenge.id, passed.instead]).toEqual([
			'cc',
			'c'
		]);
		// Shown, it is gone for this stream: nothing left anywhere to pass to.
		expect(await stream.next({ pass: true })).toEqual({ kind: 'blocked', asked: false });
	});
});
