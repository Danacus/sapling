/**
 * `generateChallenges` against a real store, in mock mode: a word with a
 * timed cue in an imported text can get a `cue-cloze` built from it locally,
 * beside the model-written kinds, and both land in the pool.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { addText, cuesFor, getPool, saveProfile, upsertItems } from '$lib/db';
import { setBackendForTesting } from '$lib/db/backend';
import { makeTestBackend } from '$lib/db/backend.testing';
import type { Challenge, KnowledgeItem, Profile } from '$lib/types';
import { generateChallenges } from './engine';

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

const TERMS = ['perro', 'gato', 'casa', 'pan', 'agua', 'mesa'];

function word(term: string, i: number): KnowledgeItem {
	return {
		id: `w${i}`,
		kind: 'vocab',
		term,
		meaning: `meaning of ${term}`,
		introducedAt: NOW - 10 * DAY,
		fsrsCard: null,
		history: []
	};
}

beforeEach(async () => {
	setBackendForTesting(await makeTestBackend('generate-test', () => NOW));
	await saveProfile(profile);
	await upsertItems(TERMS.map(word));
	await addText({
		id: 't',
		title: 'Episode',
		source: 'imported',
		segments: [
			{ text: 'Mi perro come mucho por la tarde.', start: 1000, end: 3000 },
			{ text: 'Sin tiempo.' }
		],
		media: { kind: 'youtube', videoId: 'vid' },
		createdAt: NOW - DAY
	});
});

describe('generateChallenges', () => {
	it('finds the cues a word occurs in as a word', async () => {
		const cues = await cuesFor(['w0', 'w1']);
		expect(cues).toEqual([
			{
				itemId: 'w0',
				textId: 't',
				videoId: 'vid',
				start: 1000,
				end: 3000,
				text: 'Mi perro come mucho por la tarde.'
			}
		]);
	});

	it('builds a cue-cloze locally for a word with a cue, beside the model’s kinds', async () => {
		// Each run serves what the last wrote, so the word wants again, and the
		// roll puts the cue-cloze among its kinds within a few runs.
		let built: Challenge | undefined;
		for (let seed = 0; seed < 30 && !built; seed++) {
			const served = (await getPool()).map((row) => row.id);
			const info = await generateChallenges(profile, { now: NOW, seed, served });
			expect(info.args.wants.every((want) => want.kind.type !== 'cue-cloze')).toBe(true);
			built = (await getPool()).find((row) => row.type === 'cue-cloze');
		}
		expect(built).toMatchObject({
			type: 'cue-cloze',
			sentence: 'Mi ___ come mucho por la tarde.',
			acceptedAnswers: ['perro'],
			cue: { textId: 't', videoId: 'vid', start: 1000, end: 3000 },
			itemIds: ['w0']
		});
	});
});
