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
	MAX_BATCH_CHALLENGES,
	MAX_LESSON_KINDS,
	REQUEST_ITEMS,
	allowedKinds,
	defaultChallengeCount,
	groupIntoRequests,
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

/** The identity a lesson counts distinct kinds by — and a request is cut on. */
function kindOf(slot: { type: string; bank?: boolean }): string {
	return `${slot.type}:${slot.bank ?? ''}`;
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
		const keys = slots.map(kindOf);
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
		const keys = forB.map(kindOf);
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
		// And all eight are different: freshness for the word is absolute, so a
		// word whose production group is exhausted takes a recognition kind rather
		// than answering the same format twice. That is what lets a request hold
		// one entry per word with no duplicates in it.
		expect(new Set(solo.map(kindOf)).size).toBe(8);

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

describe('groupIntoRequests', () => {
	const many = Array.from({ length: 12 }, (_, i) => item(`w${i + 1}`, 5));
	const fullLesson = (): Slot[] =>
		planSlots(argsFor(many, { count: MAX_BATCH_CHALLENGES }), cyclingRng());

	it('cuts a lesson into one request per kind', () => {
		const requests = groupIntoRequests(fullLesson());

		expect(requests.length).toBeGreaterThan(1);
		for (const request of requests) {
			expect(request.items.length).toBeGreaterThan(0);
			expect(request.items.length).toBeLessThanOrEqual(REQUEST_ITEMS);
		}
	});

	it('puts every challenge of one kind in that kind’s own request', () => {
		const slots = fullLesson();
		const requests = groupIntoRequests(slots);

		for (const request of requests) {
			for (const entry of request.items) {
				const slot = slots[entry.index];
				expect(kindOf(slot)).toBe(kindOf(request.kind));
				expect(entry.itemId).toBe(slot.itemId);
				expect(entry.term).toBe(slot.term);
				expect(entry.difficulty).toBe(slot.difficulty);
			}
		}
	});

	it('loses nothing and numbers every entry by its place in the plan', () => {
		const slots = fullLesson();
		const indices = groupIntoRequests(slots)
			.flatMap((request) => request.items.map((entry) => entry.index))
			.sort((a, b) => a - b);
		expect(indices).toEqual(slots.map((_, i) => i));
	});

	it('never asks one request about the same word twice', () => {
		// What lets a request be a flat list of words: a word never gets the same
		// kind twice in one lesson, so a request has one entry per word and the
		// reply can be matched back by the word it cites.
		for (const request of groupIntoRequests(fullLesson())) {
			const words = request.items.map((entry) => entry.itemId);
			expect(new Set(words).size).toBe(words.length);
		}
	});

	it('spills a kind with more than REQUEST_ITEMS challenges into a second request', () => {
		const wide = Array.from({ length: 8 }, (_, i) => item(`n${i + 1}`, 1));
		// Eight level-1 words, one slot each: four recognition kinds shared out, so
		// at least one of them is asked for more than REQUEST_ITEMS times only if
		// the cap forces it — force it directly instead, with a single kind.
		const slots = planSlots(argsFor(wide, { count: 8 }), FIRST);
		const requests = groupIntoRequests(slots);

		// `FIRST` always draws the first fresh candidate, so every word gets
		// recognize-mc: one kind, eight challenges, two requests.
		expect(new Set(slots.map(kindOf)).size).toBe(1);
		expect(requests).toHaveLength(2);
		expect(requests[0].items).toHaveLength(REQUEST_ITEMS);
		expect(requests[1].items).toHaveLength(8 - REQUEST_ITEMS);
		expect(kindOf(requests[1].kind)).toBe(kindOf(requests[0].kind));
	});

	it('carries the cloze bank on the request, where it belongs to the whole brief', () => {
		const slots = fullLesson();
		const clozes = groupIntoRequests(slots).filter((r) => r.kind.type === 'cloze');
		expect(clozes.length).toBeGreaterThan(0);
		for (const request of clozes) expect(typeof request.kind.bank).toBe('boolean');
		// Nothing else carries one: it is the difference between two exercises for
		// cloze and meaningless anywhere else.
		for (const request of groupIntoRequests(slots)) {
			if (request.kind.type !== 'cloze') expect(request.kind.bank).toBeUndefined();
		}
	});

	it('is one request for a small lesson', () => {
		const few = [item('a', 1)];
		expect(groupIntoRequests(planSlots(argsFor(few, { count: 1 }), FIRST))).toHaveLength(1);
	});

	it('has nothing to cut when there are no slots', () => {
		expect(groupIntoRequests([])).toEqual([]);
	});
});

describe('the lesson-wide kind cap', () => {
	const many = Array.from({ length: 12 }, (_, i) => item(`w${i + 1}`, 5));

	it('keeps a full lesson to a handful of requests instead of one per type', () => {
		// Before the cap a twenty-challenge lesson touched every kind its words
		// allowed — eight prompts to ask two or three questions each.
		const slots = planSlots(argsFor(many, { count: MAX_BATCH_CHALLENGES }), cyclingRng());
		const requests = groupIntoRequests(slots);

		expect(slots).toHaveLength(MAX_BATCH_CHALLENGES);
		expect(requests.length).toBeLessThanOrEqual(6);
		// Requests are long, not short: twenty challenges over this few briefs.
		expect(Math.max(...requests.map((r) => r.items.length))).toBeGreaterThan(3);
	});

	it('still varies which kinds a lesson opens, from one rng to another', () => {
		const kindsUnder = (rng: () => number): Set<string> =>
			new Set(planSlots(argsFor(many, { count: MAX_BATCH_CHALLENGES }), rng).map(kindOf));

		const cycling = kindsUnder(cyclingRng());
		const reversed = kindsUnder(() => 0.99);
		expect([...cycling].sort()).not.toEqual([...reversed].sort());
	});

	it('leaves a lesson below the cap exactly as it was', () => {
		// Under MAX_LESSON_KINDS the picker is the old one: fresh for the word,
		// drawn at random, with no preference for what the lesson already has.
		const slots = planSlots(argsFor(many.slice(0, 4), { count: 4 }), cyclingRng());
		expect(new Set(slots.map(kindOf)).size).toBe(MAX_LESSON_KINDS);
	});

	it('opens a new kind rather than repeating a format for one word', () => {
		// The cap yields to freshness: a lesson about one word runs through every
		// kind that word allows, cap or no cap, because reusing an open kind would
		// mean asking the same question twice.
		const solo = planSlots(argsFor([item('solo', 5)], { count: 8 }), cyclingRng());
		expect(new Set(solo.map(kindOf)).size).toBe(8);
	});
});
