/**
 * The JSON escape hatch.
 *
 * `exportData` writes the log itself and the content objects it references
 * (`{version: 4, exportedAt, events, objects}`), so a dump is complete — pool,
 * serves, results and every text body included — and importing one is a union
 * rather than a replacement. A file whose objects do not match their names is
 * refused whole. v3 files (the log alone) still union in; v1/v2 envelopes
 * predate the log and still restore, because they are the only route by which
 * a file written by the old Dexie build can arrive.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	addResult,
	recentResults,
	addText,
	addToPool,
	createProfile,
	deleteItem,
	EXPORT_VERSION,
	exportData,
	getAllItems,
	getDailyActivity,
	getItem,
	getKnownTerms,
	getPool,
	getProfile,
	getTexts,
	importData,
	markWord,
	recordLookup,
	recordServe,
	saveProfile,
	setActiveProfile,
	updateItemAfterReview,
	upsertItems,
	type ExportEnvelope
} from '$lib/db';
import type { Challenge, KnowledgeItem, Profile, ReadingText } from '$lib/types';
import { setBackendForTesting } from './backend';
import { makeTestBackend, type TestBackend } from './backend.testing';

let store: TestBackend;

beforeEach(async () => {
	store = await makeTestBackend();
	setBackendForTesting(store);
});

const profile: Profile = {
	nativeLanguage: 'nl',
	targetLanguage: 'Mandarin Chinese',
	level: 'beginner',
	interests: ['food'],
	model: 'mock',
	createdAt: 1000
};

const challenge = {
	id: 'c1',
	type: 'multiple-choice',
	direction: 'toTarget',
	itemIds: ['i1'],
	prompt: 'book?',
	options: ['书', '水'],
	answerIndex: 0
} as unknown as Challenge;

function item(id: string, term: string, introducedAt: number): KnowledgeItem {
	return {
		id,
		kind: 'vocab',
		term,
		meaning: 'book',
		introducedAt,
		// Ignored on the way in: the core folds the card from `introducedAt` and
		// the review log. Nothing on this side of the boundary can compute one.
		fsrsCard: null,
		history: []
	};
}

const text: ReadingText = {
	id: 't1',
	title: '买书',
	source: 'generated',
	topic: 'shopping',
	segments: [{ text: '我想买书。' }],
	createdAt: 6000
};

/** Seeds one write of every kind, through the repositories that produce them. */
async function seedOneOfEach(): Promise<void> {
	await saveProfile(profile);
	await upsertItems([item('i1', '书', 1000), item('i2', '旧', 1500)]);
	await updateItemAfterReview('i1', { at: 2000, grade: 3 });
	await deleteItem('i2');
	await addToPool([challenge], 3000);
	await recordServe('c1', 4000);
	await addResult({
		challengeId: 'c1',
		verdict: 'correct',
		answerGiven: '书',
		at: 5000,
		shown: 'pick-6'
	});
	await addText(text);
	await markWord('水', true);
	await recordLookup('书', 't1', 'i1');
}

/** `lookups` has no repository read yet, so the round trip checks the rows. */
function lookupRows(from: TestBackend) {
	return from.query<{ term: string; itemId: string | null; textId: string; at: number }>(
		'SELECT term, itemId, textId, at FROM lookups ORDER BY rowid'
	);
}

describe('export', () => {
	it('writes the whole log, one event per write', async () => {
		await seedOneOfEach();

		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		expect(envelope.version).toBe(4);
		expect(EXPORT_VERSION).toBe(4);
		expect(envelope.events.map((event) => event.type).sort()).toEqual([
			'challengeAdded',
			'challengeServed',
			'itemAdded',
			'itemAdded',
			'itemDeleted',
			'itemReviewed',
			'profileUpdated',
			'resultLogged',
			'textAdded',
			'wordLookedUp',
			'wordMarked'
		]);
	});

	it('produces identical events across two consecutive exports', async () => {
		await seedOneOfEach();

		const first = (JSON.parse(await exportData()) as ExportEnvelope).events;
		const second = (JSON.parse(await exportData()) as ExportEnvelope).events;

		expect(second).toEqual(first);
	});

	it('round-trips the whole read model into a fresh store', async () => {
		// The pool is the sharp end: a whole action's events share a millisecond,
		// so a replay ordered by `at` could put the serve before the challenge it
		// stamps and silently lose it. The file carries the causal order instead.
		await seedOneOfEach();
		const dump = await exportData();
		const before = {
			items: await getAllItems(),
			pool: await getPool(),
			profile: await getProfile(),
			activity: await getDailyActivity(),
			texts: await getTexts(),
			known: await getKnownTerms(),
			lookups: await lookupRows(store),
			results: await recentResults(5)
		};

		store = await makeTestBackend();
		setBackendForTesting(store);
		await importData(dump);

		expect(await getAllItems()).toEqual(before.items);
		expect(await getPool()).toEqual(before.pool);
		expect(await getProfile()).toEqual(before.profile);
		expect(await getDailyActivity()).toEqual(before.activity);
		// The `textAdded` names its body by hash, and the v4 file carries the
		// object beside it, so the text reads the moment the import returns.
		expect(before.texts).toHaveLength(1);
		expect(await getTexts()).toEqual(before.texts);
		expect(await store.missingObjects()).toEqual([]);
		expect(await getKnownTerms()).toEqual(before.known);
		expect(await lookupRows(store)).toEqual(before.lookups);
		// The help level an answer was shown at is what the difficulty model
		// learns from, so it has to survive the trip.
		expect(before.results[0]?.shown).toBe('pick-6');
		expect(await recentResults(5)).toEqual(before.results);
	});

	// An import is a copy of a log, and a log a device cannot read is still a
	// log: the row lands, materialises nothing, and leaves in the next export
	// for a build that knows what to do with it.
	it('keeps an event it cannot parse in the log, and materialises none of it', async () => {
		await seedOneOfEach();
		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		const junk = { id: 'junk', type: 'itemAdded', at: 1, device: 'devA', payload: {} };
		envelope.events.push(junk);

		setBackendForTesting(await makeTestBackend());
		await importData(JSON.stringify(envelope));

		expect((await getAllItems()).map((row) => row.id)).toEqual(['i1']);
		const again = JSON.parse(await exportData()) as ExportEnvelope;
		expect(again.events).toContainEqual(junk);
		expect(again.events).toHaveLength(envelope.events.length);
	});
});

/** A text body as the core names it: compact JSON, hashed over those bytes. */
function bodyObject(text: string) {
	const bytes = JSON.stringify({ segments: [{ text }] });
	return { hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes };
}

const spanish: Profile = { ...profile, targetLanguage: 'Spanish', createdAt: 1 };
const french: Profile = { ...profile, targetLanguage: 'French', createdAt: 2 };

function textNamed(id: string, title: string, body: string): ReadingText {
	return { id, title, source: 'imported', segments: [{ text: body }], createdAt: 7000 };
}

/** Every table an import could write, for "nothing changed". */
async function storeShape(from: TestBackend) {
	return {
		events: await from.query<{ id: string }>('SELECT id FROM events ORDER BY id'),
		objects: await from.query<{ hash: string }>('SELECT hash FROM objects ORDER BY hash'),
		items: await from.query<{ id: string }>('SELECT id FROM items ORDER BY id'),
		texts: await from.query<{ id: string }>('SELECT id FROM texts ORDER BY id')
	};
}

describe('export v4: content objects', () => {
	it('round-trips a revised text and a text in a library that is not active', async () => {
		await saveProfile(spanish);
		await addText(textNamed('t-es', 'Libro', 'Primera versión.'));
		// No repository revises a text yet; the fact is what an editor will write.
		const revised = bodyObject('Segunda versión.');
		await store.putObjects([revised]);
		await store.commit('textRevised', { textId: 't-es', content: revised.hash });
		const spanishId = (await store.listProfiles())[0].id;
		const frenchId = await createProfile(french);
		await addText(textNamed('t-fr', 'Livre', 'Un livre.'));
		await setActiveProfile(spanishId);

		const dump = await exportData();
		const envelope = JSON.parse(dump) as ExportEnvelope;
		// The French text is scoped, and its body still rides along: references
		// are derived across every library, not only the active one.
		expect(
			envelope.events.some(
				(event) =>
					event.type === 'profileEvent' && (event.payload as { type?: string }).type === 'textAdded'
			)
		).toBe(true);
		// Both bodies of the revised text, and the French one.
		expect(Object.keys(envelope.objects)).toHaveLength(3);
		expect(envelope.objects[revised.hash]).toBe(revised.bytes);

		const before = {
			spanish: await getTexts(),
			french: await (async () => {
				await setActiveProfile(frenchId);
				const texts = await getTexts();
				await setActiveProfile(spanishId);
				return texts;
			})()
		};
		expect(before.spanish.map((text) => text.segments)).toEqual([[{ text: 'Segunda versión.' }]]);
		expect(before.french.map((text) => text.id)).toEqual(['t-fr']);

		store = await makeTestBackend();
		setBackendForTesting(store);
		await importData(dump);

		expect(await store.missingObjects()).toEqual([]);
		await setActiveProfile(spanishId);
		expect(await getTexts()).toEqual(before.spanish);
		await setActiveProfile(frenchId);
		expect(await getTexts()).toEqual(before.french);
	});

	it('refuses a file whose object does not match its name, and writes nothing', async () => {
		await addText(text);
		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		const [hash] = Object.keys(envelope.objects);
		envelope.objects[hash] = JSON.stringify({ segments: [{ text: '我想买水。' }] });

		store = await makeTestBackend();
		setBackendForTesting(store);
		await upsertItems([item('mine', '我', 1)]);
		const untouched = await storeShape(store);

		await expect(importData(JSON.stringify(envelope))).rejects.toThrow(/does not match its name/);
		expect(await storeShape(store)).toEqual(untouched);
		expect(await getTexts()).toEqual([]);
	});

	it('refuses an object whose bytes are not a string', async () => {
		await addText(text);
		const envelope = JSON.parse(await exportData()) as ExportEnvelope;
		const [hash] = Object.keys(envelope.objects);
		const tampered = { ...envelope, objects: { [hash]: { segments: [] } } };

		setBackendForTesting(await makeTestBackend());
		await expect(importData(JSON.stringify(tampered))).rejects.toThrow(/does not match its name/);
		expect(await getAllItems()).toEqual([]);
	});

	it('still imports a v3 file, its content texts waiting for their objects', async () => {
		await seedOneOfEach();
		const { objects: _objects, ...v4 } = JSON.parse(await exportData()) as ExportEnvelope;
		const v3 = { ...v4, version: 3 };

		store = await makeTestBackend();
		setBackendForTesting(store);
		await importData(JSON.stringify(v3));

		expect((await getAllItems()).map((row) => row.id)).toEqual(['i1']);
		expect(await getTexts()).toEqual([]);
		expect(await store.missingObjects()).toHaveLength(1);
	});

	it('exports a text whose object it lacks without it, and the import hides that text', async () => {
		const absent = bodyObject('还没到。');
		const inline = {
			seq: 1,
			id: 'e-inline',
			type: 'textAdded',
			at: 1,
			device: 'devB',
			payload: {
				id: 't-inline',
				title: '内',
				source: 'imported',
				segments: [{ text: '在这里。' }],
				createdAt: 1
			}
		};
		const byReference = {
			seq: 2,
			id: 'e-ref',
			type: 'textAdded',
			at: 2,
			device: 'devB',
			payload: { id: 't-ref', title: '外', source: 'imported', content: absent.hash, createdAt: 2 }
		};
		await store.applyRemote([inline, byReference]);

		const dump = await exportData();
		// An inline text references nothing, and an object never fetched is not
		// the export's to fail over.
		expect((JSON.parse(dump) as ExportEnvelope).objects).toEqual({});

		store = await makeTestBackend();
		setBackendForTesting(store);
		await importData(dump);
		expect((await getTexts()).map((row) => row.id)).toEqual(['t-inline']);
		expect(await store.missingObjects()).toEqual([absent.hash]);

		// The object arriving later — off sync — is all it takes.
		await store.putObjects([absent]);
		expect((await getTexts()).map((row) => row.id).sort()).toEqual(['t-inline', 't-ref']);
	});
});

describe('legacy import', () => {
	it('accepts a v2 envelope written by the old Dexie build', async () => {
		// The old build stored a card alongside history. The new one folds the card
		// from the reviews, so the stored one is ignored rather than trusted — this
		// one is nonsense, and what comes back is the fold of `history`.
		const nonsense = { due: 1000, stability: 999, difficulty: 9, reps: 42, state: 2 };
		const legacy = JSON.stringify({
			version: 2,
			exportedAt: 9999,
			profile,
			items: [
				{
					id: 'i1',
					kind: 'vocab',
					term: '书',
					meaning: 'book',
					fsrsCard: nonsense,
					introducedAt: 1000,
					history: [{ at: 2000, grade: 3 }]
				}
			]
		});

		await importData(legacy);

		const restored = await getItem('i1');
		expect(restored?.history.map((entry) => [entry.at, entry.grade])).toEqual([[2000, 3]]);
		expect(restored).toMatchObject({ reviewCount: 1, correctCount: 1 });

		// The same word and the same one review, arriving the ordinary way. The
		// expectation comes from the store because that is the only place an FSRS
		// card is ever computed.
		setBackendForTesting(await makeTestBackend());
		await upsertItems([item('i1', '书', 1000)]);
		await updateItemAfterReview('i1', { at: 2000, grade: 3 });
		expect(restored?.fsrsCard).toEqual((await getItem('i1'))?.fsrsCard);
	});

	it('replaces existing items rather than merging into them', async () => {
		await upsertItems([item('old', '旧', 1)]);

		await importData(
			JSON.stringify({
				version: 2,
				exportedAt: 1,
				profile: null,
				items: [{ id: 'new', kind: 'vocab', term: '新', meaning: 'new', introducedAt: 2 }]
			})
		);

		expect((await getAllItems()).map((row) => row.id)).toEqual(['new']);
	});

	it('rejects an unsupported envelope version', async () => {
		await expect(importData(JSON.stringify({ version: 99, items: [] }))).rejects.toThrow(
			/unsupported export version/
		);
	});

	it('rejects a file that is not JSON', async () => {
		await expect(importData('not json')).rejects.toThrow(/not valid JSON/);
	});
});
