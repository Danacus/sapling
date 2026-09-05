/**
 * The request layer: how a list of wants becomes single-type requests, and
 * how a stored challenge is read back as the kind it is.
 *
 * Nothing here plans. The wants come from the session (`$lib/session/topup`);
 * these tests hand-write them.
 */

import { describe, expect, it } from 'vitest';
import type { Challenge } from '$lib/types';
import { WIRE_TYPE_DEFS } from './challenge-types';
import {
	PLANNABLE_KINDS,
	REQUEST_ITEMS,
	bareKind,
	groupIntoRequests,
	kindKey,
	kindOf
} from './requests';
import type { ChallengeKind, Want } from './requests';

function want(id: string, kind: ChallengeKind, difficulty: Want['difficulty'] = 3): Want {
	return { item: { id, term: `term-${id}`, meaning: `meaning ${id}` }, kind, difficulty };
}

describe('PLANNABLE_KINDS', () => {
	it('names every wire type at least once, and cloze twice — banked and not', () => {
		const types = new Set(PLANNABLE_KINDS.map((kind) => kind.type));
		expect([...types].sort()).toEqual(WIRE_TYPE_DEFS.map((def) => def.type).sort());
		expect(
			PLANNABLE_KINDS.filter((kind) => kind.type === 'cloze').map((kind) => kind.bank)
		).toEqual([true, false]);
	});

	it('has a distinct key per kind', () => {
		const keys = PLANNABLE_KINDS.map(kindKey);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('offers recognition and both tiers of production', () => {
		expect(PLANNABLE_KINDS.some((kind) => kind.demand === 0)).toBe(true);
		expect(PLANNABLE_KINDS.some((kind) => kind.demand === 1)).toBe(true);
		expect(PLANNABLE_KINDS.some((kind) => kind.demand === 2)).toBe(true);
	});
});

describe('kindKey and bareKind', () => {
	it('keys a bank-less kind by its type alone, and a cloze by its bank too', () => {
		expect(kindKey({ type: 'word-order' })).toBe('word-order');
		expect(kindKey({ type: 'cloze', bank: true })).not.toBe(
			kindKey({ type: 'cloze', bank: false })
		);
	});

	it('strips the demand off a plannable kind without touching the identity', () => {
		for (const kind of PLANNABLE_KINDS) {
			const bare = bareKind(kind);
			expect(bare).not.toHaveProperty('demand');
			expect(kindKey(bare)).toBe(kindKey(kind));
		}
	});
});

describe('kindOf', () => {
	const base = { id: 'c', itemIds: ['i1'] };

	it('tells the two multiple-choice kinds apart by direction', () => {
		const mc = (direction: 'toNative' | 'toTarget'): Challenge => ({
			...base,
			type: 'multiple-choice',
			direction,
			prompt: 'p',
			options: ['a', 'b', 'c', 'd'],
			correctIndex: 0
		});
		expect(kindOf(mc('toNative'))).toEqual({ type: 'recognize-mc' });
		expect(kindOf(mc('toTarget'))).toEqual({ type: 'produce-mc' });
	});

	it('tells the two translate kinds apart by direction', () => {
		const typed = (direction: 'toNative' | 'toTarget'): Challenge => ({
			...base,
			type: 'typed-translation',
			direction,
			prompt: 'p',
			acceptedAnswers: ['a']
		});
		expect(kindOf(typed('toNative'))).toEqual({ type: 'translate-to-native' });
		expect(kindOf(typed('toTarget'))).toEqual({ type: 'translate-to-target' });
	});

	it('reads a cloze as banked only when a word bank actually survived', () => {
		const cloze = (wordBank?: string[]): Challenge => ({
			...base,
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'a ___ b',
			acceptedAnswers: ['x'],
			translationHint: 'a x b',
			...(wordBank ? { wordBank } : {})
		});
		expect(kindOf(cloze(['x', 'y']))).toEqual({ type: 'cloze', bank: true });
		expect(kindOf(cloze([]))).toEqual({ type: 'cloze', bank: false });
		expect(kindOf(cloze())).toEqual({ type: 'cloze', bank: false });
	});

	it('is undefined for a match-pairs round', () => {
		expect(
			kindOf({ ...base, type: 'match-pairs', direction: 'toNative', pairs: [] })
		).toBeUndefined();
	});
});

describe('groupIntoRequests', () => {
	it('cuts a list of wants into one request per kind, in first-appearance order', () => {
		const wants = [
			want('a', { type: 'recognize-mc' }),
			want('a', { type: 'cloze', bank: true }),
			want('b', { type: 'recognize-mc' }),
			want('b', { type: 'word-order' }),
			want('c', { type: 'cloze', bank: true })
		];
		const requests = groupIntoRequests(wants);

		expect(requests.map((request) => kindKey(request.kind))).toEqual([
			'recognize-mc',
			'cloze:bank',
			'word-order'
		]);
		expect(requests[0].wants.map((w) => w.item.id)).toEqual(['a', 'b']);
		expect(requests[1].wants.map((w) => w.item.id)).toEqual(['a', 'c']);
		expect(requests[2].wants.map((w) => w.item.id)).toEqual(['b']);
	});

	it('keeps every want, with its word and rung, in some request', () => {
		const wants = PLANNABLE_KINDS.flatMap((kind, i) => [
			want(`w${i}`, bareKind(kind), 1),
			want(`v${i}`, bareKind(kind), 5)
		]);
		const out = groupIntoRequests(wants).flatMap((request) => request.wants);
		expect(out).toHaveLength(wants.length);
		for (const original of wants) expect(out).toContainEqual(original);
	});

	it('spills a kind with more than REQUEST_ITEMS wants into a second request of the same kind', () => {
		const wants = Array.from({ length: REQUEST_ITEMS + 2 }, (_, i) =>
			want(`w${i}`, { type: 'spot-error' })
		);
		const requests = groupIntoRequests(wants);

		expect(requests).toHaveLength(2);
		expect(requests[0].wants).toHaveLength(REQUEST_ITEMS);
		expect(requests[1].wants).toHaveLength(2);
		expect(kindKey(requests[1].kind)).toBe(kindKey(requests[0].kind));
	});

	it('never asks one request about the same word twice', () => {
		// A reply is matched back to its brief by the word each challenge cites,
		// so a second want of the same kind for the same word could never be told
		// from the first. It is dropped rather than asked for.
		const wants = [
			want('a', { type: 'recognize-mc' }),
			want('a', { type: 'recognize-mc' }),
			want('b', { type: 'recognize-mc' })
		];
		const requests = groupIntoRequests(wants);
		expect(requests).toHaveLength(1);
		expect(requests[0].wants.map((w) => w.item.id)).toEqual(['a', 'b']);
	});

	it('carries the cloze bank on the request, and nothing else carries one', () => {
		const requests = groupIntoRequests([
			want('a', { type: 'cloze', bank: false }),
			want('a', { type: 'word-order' })
		]);
		expect(requests[0].kind).toEqual({ type: 'cloze', bank: false });
		expect(requests[1].kind).toEqual({ type: 'word-order' });
		expect(requests[1].kind).not.toHaveProperty('bank');
	});

	it('strips a plannable kind’s demand off the request', () => {
		const [request] = groupIntoRequests([want('a', PLANNABLE_KINDS[0])]);
		expect(request.kind).not.toHaveProperty('demand');
	});

	it('has nothing to cut when there are no wants', () => {
		expect(groupIntoRequests([])).toEqual([]);
	});
});
