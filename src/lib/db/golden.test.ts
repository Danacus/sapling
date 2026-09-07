/**
 * Golden fixtures: a recorded event log in, the blessed answer of every read
 * method out.
 *
 * Each directory under `fixtures/` is one scenario — `events.json` as the rows
 * would arrive off sync, `expected.json` what {@link probe} reads back after
 * applying them. The test replays the log through `applyRemote`, the same gate
 * a pulled page passes, and diffs the reads against the file. `expected.json`
 * is data, not code: the Rust core reproduces it natively in `tests/golden.rs`,
 * and this file runs the same fixtures through the wasm build the browser
 * loads, so the two paths to the same rules are checked against one answer.
 *
 * Four more checks ride on every fixture, because they are what the merge
 * rules promise: applying the log twice reads the same; exporting it and
 * importing the file into a fresh backend reads the same; the exported log
 * *is* the input log, field for field (`parse_event(raw)` equals `raw` for a
 * row this build understands — the schema-strips-unknown-fields trap — and one
 * it does not is carried through untouched); and, where the fixture says its
 * rules are order-free, applying the rows in reverse arrival order reads the
 * same.
 *
 * Rebless after a deliberate change with `pnpm golden:update` — the diff in
 * `expected.json` is then the review.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestBackend, type TestBackend } from './backend.testing';
import type { Backend } from './protocol';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** {@link Backend.recentResults}'s limit, as probed. Fixtures store more than this. */
const RECENT_LIMIT = 5;
/** {@link Backend.pendingEvents}'s limit, as probed. */
const PENDING_LIMIT = 100;

/**
 * `daily` buckets by local calendar day, so the reads are only reproducible
 * under one time zone. Pinned for this file and put back afterwards.
 */
const originalTz = process.env.TZ;
beforeAll(() => {
	process.env.TZ = 'UTC';
});
afterAll(() => {
	if (originalTz === undefined) delete process.env.TZ;
	else process.env.TZ = originalTz;
});

interface RawEvent {
	seq: number;
	id: string;
	type: string;
	at: number;
	device: string;
	payload: unknown;
}

interface Fixture {
	name: string;
	dir: string;
	meta: {
		deviceId: string;
		now: number;
		/** Whether every rule the log exercises is arrival-order independent. */
		orderFree: boolean;
		note?: string;
	};
	events: RawEvent[];
}

function loadFixtures(): Fixture[] {
	return readdirSync(FIXTURES, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const dir = join(FIXTURES, entry.name);
			const file = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')) as Omit<
				Fixture,
				'name' | 'dir'
			>;
			return { name: entry.name, dir, ...file };
		})
		.sort((a, b) => compare(a.name, b.name));
}

/** Code-unit order: the same on every platform and in every language, unlike a locale sort. */
function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function byId<T extends { id: string }>(rows: T[]): T[] {
	return [...rows].sort((a, b) => compare(a.id, b.id));
}

function unique(values: (string | undefined)[]): string[] {
	return [...new Set(values.filter((v): v is string => typeof v === 'string'))].sort(compare);
}

function field(payload: unknown, key: string): string | undefined {
	const value = (payload as Record<string, unknown> | null)?.[key];
	return typeof value === 'string' ? value : undefined;
}

/** Every id the log mentions, per kind — what the parameterised reads are probed with. */
function idsIn(events: RawEvent[]) {
	const of = (types: string[], key: string) =>
		events.filter((e) => types.includes(e.type)).map((e) => field(e.payload, key));
	return {
		items: unique([
			...of(['itemAdded'], 'id'),
			...of(['itemReviewed', 'reviewAmended', 'itemUpdated', 'itemDeleted'], 'itemId')
		]),
		challenges: unique([
			...events
				.filter((e) => e.type === 'challengeAdded')
				.map((e) => field((e.payload as { challenge?: unknown }).challenge, 'id')),
			...of(['challengeServed', 'challengeReported', 'resultLogged'], 'challengeId')
		]),
		texts: unique([...of(['textAdded'], 'id'), ...of(['textDeleted', 'wordLookedUp'], 'textId')]),
		conversations: unique([
			...of(['conversationStarted'], 'id'),
			...of(['turnAdded', 'conversationDeleted'], 'conversationId')
		])
	};
}

/** JSON round-trip: what the file can hold. `undefined` results become `null`. */
function canonical<T>(value: T): T {
	return JSON.parse(JSON.stringify(value === undefined ? null : value)) as T;
}

async function byKey<T>(ids: string[], read: (id: string) => Promise<T>) {
	const entries = await Promise.all(ids.map(async (id) => [id, (await read(id)) ?? null] as const));
	return Object.fromEntries(entries);
}

/**
 * Every read on the {@link Backend}, in a fixed shape.
 *
 * Reads the protocol leaves unordered — `getAllItems`, `getPool`,
 * `getChallengesByIds`, `getKnownTerms` — are sorted here, so two arrival
 * orders that differ only in row order compare equal. Ordered reads are
 * recorded as returned; the fixtures avoid ties in their sort keys.
 */
async function probe(backend: Backend, events: RawEvent[]): Promise<Record<string, unknown>> {
	const ids = idsIn(events);
	return canonical({
		getProfile: await backend.getProfile(),
		getAllItems: {
			lean: byId(await backend.getAllItems()),
			withRecentGrades: byId(await backend.getAllItems({ withRecentGrades: true }))
		},
		getItem: await byKey(ids.items, (id) => backend.getItem(id)),
		getPool: byId(await backend.getPool()),
		poolSize: await backend.poolSize(),
		getChallengesByIds: byId(await backend.getChallengesByIds(ids.challenges)),
		recentResults: await backend.recentResults(RECENT_LIMIT),
		getDailyActivity: await backend.getDailyActivity(),
		getTexts: await backend.getTexts(),
		getText: await byKey(ids.texts, (id) => backend.getText(id)),
		getKnownTerms: [...(await backend.getKnownTerms())].sort(compare),
		getConversations: await backend.getConversations(),
		getConversation: await byKey(ids.conversations, (id) => backend.getConversation(id)),
		exportData: JSON.parse(await backend.exportData()) as unknown,
		pendingEvents: await backend.pendingEvents(PENDING_LIMIT),
		getPullCursor: await backend.getPullCursor()
	});
}

/** The reads that are data. Sync bookkeeping differs, by design, on a backend that imported the log. */
function dataOnly(reads: Record<string, unknown>): Record<string, unknown> {
	const { pendingEvents: _pending, getPullCursor: _cursor, ...data } = reads;
	return data;
}

async function fresh(fixture: Fixture): Promise<TestBackend> {
	return makeTestBackend(fixture.meta.deviceId, () => fixture.meta.now);
}

async function applied(fixture: Fixture, events: RawEvent[] = fixture.events) {
	const backend = await fresh(fixture);
	const count = await backend.applyRemote(events);
	return { backend, count };
}

function expectedOf(fixture: Fixture): Record<string, unknown> | undefined {
	const path = join(fixture.dir, 'expected.json');
	return existsSync(path)
		? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
		: undefined;
}

describe('golden fixtures', () => {
	const fixtures = loadFixtures();

	it('has fixtures to run', () => {
		expect(fixtures.length).toBeGreaterThan(0);
	});

	for (const fixture of fixtures) {
		describe(fixture.name, () => {
			// Every row reaches the log, including one this build cannot type —
			// `applyRemote` turns away only something that is not an envelope at
			// all, or carries no `seq`, and either is a fixture bug.
			it('logs every row — a row the gate rejects is a fixture bug, not a case', async () => {
				const { count } = await applied(fixture);
				expect(count).toBe(fixture.events.length);
			});

			it(UPDATE ? 'writes expected.json' : 'reads match expected.json', async () => {
				const { backend } = await applied(fixture);
				const reads = await probe(backend, fixture.events);
				if (UPDATE) {
					writeFileSync(
						join(fixture.dir, 'expected.json'),
						JSON.stringify(reads, null, '\t') + '\n'
					);
					return;
				}
				const expected = expectedOf(fixture);
				expect(
					expected,
					`${fixture.name}/expected.json is missing — run pnpm golden:update`
				).toBeDefined();
				expect(reads).toEqual(expected);
			});

			it('reads the same after applying the log twice', async () => {
				const { backend } = await applied(fixture);
				const once = await probe(backend, fixture.events);
				await backend.applyRemote(fixture.events);
				expect(await probe(backend, fixture.events)).toEqual(once);
			});

			it('reads the same from a fresh backend that imported the export', async () => {
				const { backend } = await applied(fixture);
				const restored = await fresh(fixture);
				await restored.importData(await backend.exportData());
				expect(dataOnly(await probe(restored, fixture.events))).toEqual(
					dataOnly(await probe(backend, fixture.events))
				);
			});

			it('exports the log it was given, field for field', async () => {
				const { backend } = await applied(fixture);
				const exported = JSON.parse(await backend.exportData()) as { events: unknown[] };
				const seen = new Set<string>();
				const input = fixture.events
					.filter((event) => !seen.has(event.id) && seen.add(event.id))
					.sort((a, b) => a.seq - b.seq)
					.map(({ seq: _seq, ...event }) => event);
				expect(exported.events).toEqual(input);
			});

			(fixture.meta.orderFree ? it : it.skip)(
				'reads the same in reverse arrival order',
				async () => {
					const forwards = await applied(fixture);
					const backwards = await applied(fixture, [...fixture.events].reverse());
					expect(await probe(backwards.backend, fixture.events)).toEqual(
						await probe(forwards.backend, fixture.events)
					);
				}
			);
		});
	}
});
