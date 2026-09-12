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
	isActiveKind,
	isKindAvailableAt,
	kindKey,
	kindOf
} from './requests';
import type { ChallengeKind, Want } from './requests';

function want(id: string, kind: ChallengeKind, difficulty: Want['difficulty'] = 3): Want {
	return { item: { id, term: `term-${id}`, meaning: `meaning ${id}` }, kind, difficulty };
}

describe('PLANNABLE_KINDS', () => {
	it('names active wire types, while retired wire types remain parseable', () => {
		const types = new Set(PLANNABLE_KINDS.map((kind) => kind.type));
		expect([...types].sort()).toEqual(
			WIRE_TYPE_DEFS.map((def) => def.type)
				.filter((type) => type !== 'translate-to-target')
				.sort()
		);
		expect(isActiveKind({ type: 'translate-to-target' })).toBe(false);
		expect(isActiveKind({ type: 'translate-to-native' })).toBe(true);
		expect(WIRE_TYPE_DEFS.some((def) => def.type === 'translate-to-target')).toBe(true);
		// One cloze kind now — no more banked/typed split at planning time.
		expect(PLANNABLE_KINDS.filter((kind) => kind.type === 'cloze')).toHaveLength(1);
	});

	it('publishes the gradual level availability ladder', () => {
		const available = (type: ChallengeKind['type'], level: Want['difficulty']) =>
			isKindAvailableAt({ type }, level);

		expect(available('recognize-mc', 1)).toBe(true);
		expect(available('recognize-mc', 3)).toBe(false);
		expect(available('translate-to-native', 1)).toBe(true);
		expect(available('translate-to-native', 2)).toBe(false);
		expect(available('spot-error', 2)).toBe(true);
		expect(available('spot-error', 4)).toBe(false);
		expect(available('word-order', 2)).toBe(true);
		expect(available('word-order', 5)).toBe(false);
		expect(available('cloze', 2)).toBe(true);
		expect(available('cloze', 5)).toBe(true);
		expect(available('cloze', 1)).toBe(false);
	});

	it('has a distinct key per kind', () => {
		const keys = PLANNABLE_KINDS.map(kindKey);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('offers recognition and constrained production; free production is served, never planned', () => {
		// No kind is planned at demand 2 any more: cloze — the only kind that
		// ever was — is planned and stored at demand 1 for every rung, even the
		// top one, where a served row shows no bank and is answered exactly like
		// a demand-2 challenge. `$lib/session/progression`'s `servedDemand` is
		// what reconciles that, at serve time, never here.
		expect(PLANNABLE_KINDS.some((kind) => kind.demand === 0)).toBe(true);
		expect(PLANNABLE_KINDS.some((kind) => kind.demand === 1)).toBe(true);
		expect(PLANNABLE_KINDS.some((kind) => kind.demand === 2)).toBe(false);
	});
});

describe('kindKey and bareKind', () => {
	it('keys a kind by its type alone', () => {
		expect(kindKey({ type: 'word-order' })).toBe('word-order');
		expect(kindKey({ type: 'cloze' })).toBe('cloze');
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

	it('tells context-mc from produce-mc by promptIsTarget, both toTarget', () => {
		const contextRow: Challenge = {
			...base,
			type: 'multiple-choice',
			direction: 'toTarget',
			promptIsTarget: true,
			prompt: 'p',
			options: ['a', 'b', 'c', 'd'],
			correctIndex: 0
		};
		const produceRow: Challenge = {
			...base,
			type: 'multiple-choice',
			direction: 'toTarget',
			prompt: 'p',
			options: ['a', 'b', 'c', 'd'],
			correctIndex: 0
		};
		expect(kindOf(contextRow)).toEqual({ type: 'context-mc' });
		expect(kindOf(produceRow)).toEqual({ type: 'produce-mc' });
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

	it('reads a cloze as the one cloze kind, whether or not a word bank survived', () => {
		// Unlike `demandOf` (`$lib/challenges/demand`), which still reads the
		// stored `wordBank` to tell a constrained-production row from a
		// free-production one — `kindOf` only ever answers "this is a cloze".
		const cloze = (wordBank?: string[]): Challenge => ({
			...base,
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'a ___ b',
			acceptedAnswers: ['x'],
			translationHint: 'a x b',
			...(wordBank ? { wordBank } : {})
		});
		expect(kindOf(cloze(['x', 'y']))).toEqual({ type: 'cloze' });
		expect(kindOf(cloze([]))).toEqual({ type: 'cloze' });
		expect(kindOf(cloze())).toEqual({ type: 'cloze' });
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
			want('a', { type: 'cloze' }),
			want('b', { type: 'recognize-mc' }),
			want('b', { type: 'word-order' }),
			want('c', { type: 'cloze' })
		];
		const requests = groupIntoRequests(wants);

		expect(requests.map((request) => kindKey(request.kind))).toEqual([
			'recognize-mc',
			'cloze',
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

	it('carries only the type on a request, whatever the kind', () => {
		const requests = groupIntoRequests([
			want('a', { type: 'cloze' }),
			want('a', { type: 'word-order' })
		]);
		expect(requests[0].kind).toEqual({ type: 'cloze' });
		expect(requests[1].kind).toEqual({ type: 'word-order' });
	});

	it('strips a plannable kind’s demand off the request', () => {
		const [request] = groupIntoRequests([want('a', PLANNABLE_KINDS[0])]);
		expect(request.kind).not.toHaveProperty('demand');
	});

	it('has nothing to cut when there are no wants', () => {
		expect(groupIntoRequests([])).toEqual([]);
	});
});
