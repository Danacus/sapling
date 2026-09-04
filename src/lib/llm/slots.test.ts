/**
 * Guards on local slot planning.
 *
 * These rules used to be prose in the system prompt, where the only way to know
 * whether they held was to read a generated lesson and count. Now they are a
 * pure function, and this file is the thing that could never exist before: an
 * assertion that a level-1 word is never asked to produce, that the mix moves
 * with the learner's accuracy, that a word they just failed gets another go in
 * a shape it has not already had — and, in `describe('difficulty', ...)`, that
 * every slot's own `difficulty` tracks its item's level plus the same two
 * shifts, continuously rather than as a cliff.
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

/**
 * The kinds where the learner produces the target language, banked or not.
 * A banked cloze is one of them: the words are given, but which one fits the
 * sentence is not, which is demand 1 on the stored side and not recognition.
 */
const PRODUCTION_TYPES = new Set(['translate-to-target', 'word-order', 'cloze']);

function isProduction(slot: Slot): boolean {
	return PRODUCTION_TYPES.has(slot.type);
}

function item(id: string, level?: ReviewItemRef['level']): ReviewItemRef {
	return { id, term: `term-${id}`, meaning: `meaning ${id}`, ...(level ? { level } : {}) };
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
	it('lets a level-1 word be recognized but never produced', () => {
		const { recognition, production } = allowedKinds(1);
		expect(production).toEqual([]);
		expect(recognition.map((k) => k.type)).toContain('recognize-mc');
		// Not even a banked cloze: it reports demand 1 on the stored side, so the
		// session planner would decline to serve one for a word this new.
		expect(recognition.some((k) => k.type === 'cloze')).toBe(false);
	});

	it('opens word-order and banked cloze at levels 2-3, free production at 4-5', () => {
		for (const level of [2, 3] as const) {
			const young = allowedKinds(level).production;
			expect(young.map((k) => k.type)).toEqual(['word-order', 'cloze']);
			expect(young.find((k) => k.type === 'cloze')?.bank).toBe(true);
		}
		for (const level of [4, 5] as const) {
			const solid = allowedKinds(level).production;
			expect(solid.map((k) => k.type)).toEqual([
				'word-order',
				'cloze',
				'translate-to-target',
				'cloze'
			]);
			expect(solid.filter((k) => k.type === 'cloze').map((k) => k.bank)).toEqual([true, false]);
		}
	});

	it('treats an item with no level as level 1 — the cautious end', () => {
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
	const solid = [item('a', 5), item('b', 5), item('c', 5)];

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
		const slots = planSlots(argsFor([item('a', 5)], { count: 4 }), cyclingRng());
		const keys = slots.map((s) => `${s.type}:${s.bank ?? ''}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('never asks a new word to be produced', () => {
		const slots = planSlots(
			argsFor([item('a'), item('b', 1)], { count: 8, recentAccuracy: 1 }),
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

	it('charges the production budget only to the slots that can pay it', () => {
		// Four brand-new words beside two mature ones. The new words' slots can
		// never be production, so counting them in the denominator spent the whole
		// lesson's production budget on the two mature words — which came back
		// 100% production, the hardest possible lesson for the words closest to
		// being forgotten.
		const mixed = [
			item('n1', 1),
			item('n2', 1),
			item('n3', 1),
			item('n4', 1),
			item('m1', 5),
			item('m2', 5)
		];
		const slots = planSlots(argsFor(mixed, { count: 12, recentAccuracy: 0.95 }), cyclingRng());
		const mature = slots.filter((s) => s.itemId.startsWith('m'));

		expect(slots).toHaveLength(12);
		// Every new word's slot is recognition, as before.
		expect(slots.filter((s) => s.itemId.startsWith('n')).some(isProduction)).toBe(false);
		// And the mature words' four slots split near `productionShare`'s 0.6
		// rather than going all the way over: two production, two recognition.
		expect(mature).toHaveLength(4);
		expect(mature.filter(isProduction)).toHaveLength(2);
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

	it('stops asking one word more questions than it has kinds', () => {
		// One review word and a count of fourteen used to deal fourteen slots onto
		// it, of which only eight could be different questions; the rest repeated a
		// format the learner had already answered in the same lesson.
		const solo = planSlots(argsFor([item('solo', 5)], { count: 14 }), cyclingRng());
		expect(solo).toHaveLength(8); // four recognition kinds plus four production
		// The cap counts the kinds a word may be asked in, not the kinds it ends up
		// with: the recognition/production mix can still empty one group and repeat
		// inside it. What it rules out is the second lap over everything.
		expect(new Set(solo.map((s) => `${s.type}:${s.bank ?? ''}`)).size).toBeGreaterThanOrEqual(7);

		// A level-1 word has fewer kinds open to it, so its ceiling is lower.
		const shallow = planSlots(argsFor([item('new', 1)], { count: 14 }), cyclingRng());
		expect(shallow).toHaveLength(4);

		// The cap is per item: more words, more room.
		expect(planSlots(argsFor(solid, { count: 14 }), cyclingRng())).toHaveLength(14);
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

	describe('difficulty', () => {
		it('puts a 1-5 difficulty on every slot', () => {
			for (const slot of planSlots(argsFor(solid, { count: 6 }), cyclingRng())) {
				expect(slot.difficulty).toBeGreaterThanOrEqual(1);
				expect(slot.difficulty).toBeLessThanOrEqual(5);
			}
		});

		it("defaults to the item's own level with no accuracy history", () => {
			const mixed = [item('a', 1), item('b', 3), item('c', 5)];
			const slots = planSlots(argsFor(mixed, { count: 3 }), FIRST);
			expect(slots.find((s) => s.itemId === 'a')?.difficulty).toBe(1);
			expect(slots.find((s) => s.itemId === 'b')?.difficulty).toBe(3);
			expect(slots.find((s) => s.itemId === 'c')?.difficulty).toBe(5);
		});

		it('shifts every slot down a rung when the learner is struggling', () => {
			const slots = planSlots(argsFor([item('a', 3)], { count: 1, recentAccuracy: 0.5 }), FIRST);
			expect(slots[0].difficulty).toBe(2);
		});

		it('steps on the two bounds it names, and nowhere else', () => {
			// The shift used to be `round((acc - 0.7) * 4)` clamped on its *output*,
			// which put the real seams at 0.575 and 0.825 — neither of them a
			// number this module states anywhere. Three values, two named bounds:
			// below ACCURACY_FLOOR, between, and at or above ACCURACY_CEILING.
			const at = (recentAccuracy: number) =>
				planSlots(argsFor([item('a', 3)], { count: 1, recentAccuracy }), FIRST)[0].difficulty;

			expect(at(0.69)).toBe(2);
			expect(at(0.7)).toBe(3);
			expect(at(0.72)).toBe(3);
			expect(at(0.83)).toBe(3);
			expect(at(0.85)).toBe(4);
		});

		it('leaves difficulty alone at the middle of the accuracy band', () => {
			const slots = planSlots(argsFor([item('a', 3)], { count: 1, recentAccuracy: 0.7 }), FIRST);
			expect(slots[0].difficulty).toBe(3);
		});

		it('shifts every slot up a rung once the learner clears the accuracy ceiling', () => {
			const slots = planSlots(argsFor([item('a', 3)], { count: 1, recentAccuracy: 0.85 }), FIRST);
			expect(slots[0].difficulty).toBe(4);
		});

		it('clamps the accuracy shift to the 1-5 range rather than overshooting it', () => {
			const low = planSlots(argsFor([item('a', 1)], { count: 1, recentAccuracy: 0.5 }), FIRST);
			expect(low[0].difficulty).toBe(1);
			const high = planSlots(argsFor([item('a', 5)], { count: 1, recentAccuracy: 0.95 }), FIRST);
			expect(high[0].difficulty).toBe(5);
		});

		it('pulls every slot about a wrongly-answered word down a rung, not only the extra one', () => {
			const slots = planSlots(
				argsFor(solid, { count: 6, recentMistakes: [{ term: 'term-b', gave: 'wrong' }] }),
				cyclingRng()
			);
			for (const slot of slots.filter((s) => s.itemId === 'b')) expect(slot.difficulty).toBe(4);
			for (const slot of slots.filter((s) => s.itemId !== 'b')) expect(slot.difficulty).toBe(5);
		});

		it('lets a skipped mistake reach only the extra slot it earned', () => {
			// A skip says the *format* was too early, not that the word is shaky —
			// and the extra slot is already forced to recognition for exactly that
			// reason. Pulling the word's other slots down too would shorten every
			// recognize-mc about a word whose only sin was meeting a production
			// format a few days early.
			const slots = planSlots(
				argsFor(solid, { count: 6, recentMistakes: [{ term: 'term-a', gave: '(skipped)' }] }),
				cyclingRng()
			);
			// `demands` inserts the extra slot right after the first pass.
			expect(slots[3].itemId).toBe('a');
			expect(slots[3].difficulty).toBe(4);
			for (const [index, slot] of slots.entries()) {
				if (index === 3) continue;
				expect(slot.difficulty).toBe(5);
			}
		});
	});
});

describe('chunkSlots', () => {
	const many = Array.from({ length: 12 }, (_, i) => item(`w${i + 1}`, 5));

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
		const one = [item('solo', 5)];
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
