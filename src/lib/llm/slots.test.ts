/**
 * Guards on local slot planning.
 *
 * These rules used to be prose in the system prompt, where the only way to know
 * whether they held was to read a generated lesson and count. Now they are a
 * pure function, and this file is the thing that could never exist before: an
 * assertion that a `new` word is never asked to produce, that the mix moves with
 * the learner's accuracy, and that a word they just failed gets another go in a
 * shape it has not already had.
 */

import { describe, expect, it } from 'vitest';
import type { BatchArgs, ReviewItemRef } from './generate';
import {
	CHUNK_ITEMS,
	CHUNK_SLOTS,
	MAX_BATCH_CHALLENGES,
	allowedKinds,
	chunkSlots,
	defaultChallengeCount,
	planSlots,
	productionShare
} from './slots';
import type { Slot } from './slots';

const PRODUCTION_TYPES = new Set(['translate-to-target', 'word-order']);

/** Bankless cloze is production; cloze with a bank is recognition. */
function isProduction(slot: Slot): boolean {
	if (slot.type === 'cloze') return slot.bank === false;
	return PRODUCTION_TYPES.has(slot.type);
}

function item(id: string, maturity?: ReviewItemRef['maturity']): ReviewItemRef {
	return { id, term: `term-${id}`, meaning: `meaning ${id}`, ...(maturity ? { maturity } : {}) };
}

function argsFor(items: ReviewItemRef[], extra: Partial<BatchArgs> = {}): BatchArgs {
	return {
		profile: {
			nativeLanguage: 'English',
			targetLanguage: 'Spanish',
			level: 'beginner',
			interests: []
		},
		reviewItems: items,
		...extra
	};
}

/** Deterministic, and not a constant: it walks a fixed cycle of the [0,1) range. */
function cyclingRng(): () => number {
	const values = [0, 0.31, 0.67, 0.99, 0.5, 0.14];
	let n = 0;
	return () => values[n++ % values.length];
}

const FIRST = () => 0;

describe('allowedKinds', () => {
	it('lets a new word be recognized but never produced', () => {
		const { recognition, production } = allowedKinds('new');
		expect(production).toEqual([]);
		expect(recognition.map((k) => k.type)).toContain('recognize-mc');
		// A cloze for a new word always comes with its word bank.
		expect(recognition.find((k) => k.type === 'cloze')?.bank).toBe(true);
	});

	it('opens word-order at young and free production at solid', () => {
		expect(allowedKinds('young').production.map((k) => k.type)).toEqual(['word-order']);
		const solid = allowedKinds('solid').production;
		expect(solid.map((k) => k.type)).toEqual(['word-order', 'translate-to-target', 'cloze']);
		expect(solid.find((k) => k.type === 'cloze')?.bank).toBe(false);
	});

	it('treats an item with no maturity as new — the cautious end', () => {
		expect(allowedKinds(undefined).production).toEqual([]);
	});
});

describe('productionShare', () => {
	it('moves with recent accuracy, around the thresholds the prompt used to state', () => {
		expect(productionShare(undefined)).toBe(0.4);
		expect(productionShare(0.6)).toBeLessThan(productionShare(0.8));
		expect(productionShare(0.8)).toBeLessThan(productionShare(0.95));
		expect(productionShare(0.69)).toBe(0.2);
		expect(productionShare(0.86)).toBe(0.6);
	});
});

describe('planSlots', () => {
	const solid = [item('a', 'solid'), item('b', 'solid'), item('c', 'solid')];

	it('honours the requested count, and caps it', () => {
		expect(planSlots(argsFor(solid, { count: 7 }), FIRST)).toHaveLength(7);
		expect(planSlots(argsFor(solid), FIRST)).toHaveLength(defaultChallengeCount(3));
		expect(planSlots(argsFor(solid, { count: 999 }), FIRST)).toHaveLength(MAX_BATCH_CHALLENGES);
	});

	it('plans nothing when there is no vocabulary to plan about', () => {
		expect(planSlots(argsFor([]), FIRST)).toEqual([]);
		expect(planSlots(argsFor(solid, { count: 0 }), FIRST)).toEqual([]);
	});

	it('spreads slots evenly over the review items', () => {
		const slots = planSlots(argsFor(solid, { count: 6 }), cyclingRng());
		const perItem = new Map<string, number>();
		for (const slot of slots) perItem.set(slot.itemId, (perItem.get(slot.itemId) ?? 0) + 1);
		expect([...perItem.values()]).toEqual([2, 2, 2]);
	});

	it('gives one item different types rather than the same one twice', () => {
		const slots = planSlots(argsFor([item('a', 'solid')], { count: 4 }), cyclingRng());
		const keys = slots.map((s) => `${s.type}:${s.bank ?? ''}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('never asks a new word to be produced', () => {
		const slots = planSlots(
			argsFor([item('a'), item('b', 'new')], { count: 8, recentAccuracy: 1 }),
			cyclingRng()
		);
		expect(slots).toHaveLength(8);
		expect(slots.some(isProduction)).toBe(false);
	});

	it('mixes recognition and production once the words can take it', () => {
		const slots = planSlots(argsFor(solid, { count: 9 }), cyclingRng());
		const production = slots.filter(isProduction).length;
		expect(production).toBeGreaterThan(0);
		expect(production).toBeLessThan(slots.length);
	});

	it('favours recognition when the learner is struggling and production when they are not', () => {
		const shaky = planSlots(argsFor(solid, { count: 10, recentAccuracy: 0.5 }), cyclingRng());
		const strong = planSlots(argsFor(solid, { count: 10, recentAccuracy: 0.95 }), cyclingRng());

		expect(shaky.filter(isProduction)).toHaveLength(2); // 0.2 of ten
		expect(strong.filter(isProduction)).toHaveLength(6); // 0.6 of ten
	});

	it('gives a just-failed word an extra slot, in a shape it has not had', () => {
		const slots = planSlots(
			argsFor(solid, { count: 7, recentMistakes: [{ term: 'term-b', gave: 'wrong' }] }),
			cyclingRng()
		);
		const forB = slots.filter((s) => s.itemId === 'b');
		expect(forB.length).toBeGreaterThan(slots.filter((s) => s.itemId === 'c').length);
		const keys = forB.map((s) => `${s.type}:${s.bank ?? ''}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('re-practises a skipped word with a recognition format', () => {
		// "(skipped)" means the format itself was too much, so the extra go is
		// recognition however strong the word is and however well they are doing.
		const slots = planSlots(
			argsFor(solid, {
				count: 12,
				recentAccuracy: 0.99,
				recentMistakes: [{ term: 'term-a', gave: '(skipped)' }]
			}),
			cyclingRng()
		);
		// The extra slot sits right after the first pass over the items.
		expect(slots[3].itemId).toBe('a');
		expect(isProduction(slots[3])).toBe(false);
	});

	it('ignores a mistake for a word this lesson is not about', () => {
		const withGhost = planSlots(
			argsFor(solid, { count: 6, recentMistakes: [{ term: 'not-in-this-lesson', gave: 'x' }] }),
			FIRST
		);
		expect(withGhost.map((s) => s.itemId)).toEqual(
			planSlots(argsFor(solid, { count: 6 }), FIRST).map((s) => s.itemId)
		);
	});

	it('is deterministic for a given rng', () => {
		const a = planSlots(argsFor(solid, { count: 9 }), cyclingRng());
		const b = planSlots(argsFor(solid, { count: 9 }), cyclingRng());
		expect(a).toEqual(b);
	});

	it('names the term beside the id, so a chunk payload needs no second lookup', () => {
		for (const slot of planSlots(argsFor(solid, { count: 6 }), FIRST)) {
			expect(slot.term).toBe(`term-${slot.itemId}`);
		}
	});
});

describe('chunkSlots', () => {
	const many = Array.from({ length: 12 }, (_, i) => item(`w${i + 1}`, 'solid'));

	it('cuts a full lesson into short requests about few words each', () => {
		const args = argsFor(many, { count: MAX_BATCH_CHALLENGES });
		const chunks = chunkSlots(planSlots(args, cyclingRng()), many);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.slots.length).toBeLessThanOrEqual(CHUNK_SLOTS);
			expect(chunk.reviewItems.length).toBeLessThanOrEqual(CHUNK_ITEMS);
			expect(chunk.slots.length).toBeGreaterThan(0);
		}
	});

	it('loses no slot and keeps every one in a chunk that names its word', () => {
		const args = argsFor(many, { count: MAX_BATCH_CHALLENGES });
		const slots = planSlots(args, cyclingRng());
		const chunks = chunkSlots(slots, many);

		expect(chunks.flatMap((c) => c.slots)).toHaveLength(slots.length);
		for (const chunk of chunks) {
			for (const slot of chunk.slots) {
				expect(chunk.reviewItems.map((i) => i.id)).toContain(slot.itemId);
			}
		}
	});

	it("keeps a word's slots together in one request", () => {
		const args = argsFor(many.slice(0, 6), { count: 12 });
		const chunks = chunkSlots(planSlots(args, cyclingRng()), many.slice(0, 6));

		const seen = new Map<string, number>();
		for (const [index, chunk] of chunks.entries()) {
			for (const slot of chunk.slots) {
				const at = seen.get(slot.itemId);
				if (at !== undefined) expect(at).toBe(index);
				seen.set(slot.itemId, index);
			}
		}
	});

	it('splits only a word that alone outgrows a chunk', () => {
		const one = [item('solo', 'solid')];
		const chunks = chunkSlots(planSlots(argsFor(one, { count: 8 }), cyclingRng()), one);
		expect(chunks).toHaveLength(2);
		expect(chunks[0].slots).toHaveLength(CHUNK_SLOTS);
		expect(chunks[1].slots).toHaveLength(3);
	});

	it('is one chunk for a small lesson', () => {
		const few = many.slice(0, 2);
		expect(chunkSlots(planSlots(argsFor(few), cyclingRng()), few)).toHaveLength(1);
	});

	it('has nothing to cut when there are no slots', () => {
		expect(chunkSlots([], many)).toEqual([]);
	});
});
