/**
 * Slot planning: deciding *which* challenges a lesson is made of, locally.
 *
 * This used to be the model's job. The prompt carried a paragraph of
 * type-selection rules — match the type to the word's maturity, mix recognition
 * and production, give a failed word another go in a different format — and the
 * model had to hold all of it in mind while also writing twenty challenges. It
 * did neither especially well, and every token of that paragraph was paid on
 * every call.
 *
 * So the choice moves here. A slot is one challenge to write: which word it is
 * about and which wire type it has to be. {@link groupIntoRequests} then cuts
 * the plan by *kind*, so each request asks for one type and nothing else — the
 * model is handed a list of words and a couple of counts and asked to write six
 * of the same thing, which is a much smaller question than a mixed brief and
 * one it answers far more reliably. What stays in the prompt is the part that is
 * genuinely about *content*: what a lesson should sound like, and what each
 * count means for the one type that request is about.
 *
 * Everything here is pure and deterministic given an injectable `rng`, so a plan
 * can be replayed in a test without a network or a clock.
 *
 * The one input it reads about a word is `level` — the same five-rung ladder the
 * session planner gates *serving* on (`difficultyLevelOf` in
 * `$lib/session/progression`, expressed here as a bare `1..5` rather than
 * imported, since `$lib/llm` never reaches into `$lib/session`). It does two
 * jobs now instead of one: {@link allowedKinds} still reads it at the old
 * three-bucket resolution to decide which *types* a word may be asked in, and
 * {@link planSlots} also folds it — plus a whole-rung shift for how the learner
 * is doing and whether this word was just missed — into each slot's own
 * `difficulty`, 1..5. That rung is the last purely local number in the chain:
 * `./generate` never sends it, and asks each wire def what it *means* instead
 * (`params`), so what travels is a sentence length, a bank size, a tile count.
 */

import { termKey } from '$lib/text';
import type { DifficultyRung, SizingKind, WireType } from './challenge-types';
import type { BatchArgs, RecentMistake, ReviewItemRef } from './generate';

/**
 * A wire type together with the one presentation choice that changes how hard
 * it is: whether a cloze comes with a word bank.
 *
 * The bank is a type-level decision, not a content one — "cloze WITH
 * distractorWords" and "cloze without" are two different exercises for two
 * different stages of a word — so it is planned here and told to the model,
 * rather than left for it to guess.
 */
export interface SlotKind extends SizingKind {
	type: WireType;
	/** `cloze` only: `true` asks for `distractorWords`, `false` forbids them. */
	bank?: boolean;
}

/**
 * A slot's difficulty, 1-5, on the same ladder `ReviewItemRef.level` reads.
 *
 * It never leaves this side. A rung is a *local* summary of how hard a word
 * should be worked; what the model is told is what that rung means for the type
 * it is writing — a word count, a bank size, a tile count — which each wire def
 * spells out in its own `params`.
 */
export type SlotDifficulty = DifficultyRung;

/** One challenge to generate: the word it is about, and the shape it takes. */
export interface Slot extends SlotKind {
	/** The review item's id — the same id the resolver will accept back. */
	itemId: string;
	/** The word itself, so a request's payload can name it without a second lookup. */
	term: string;
	/**
	 * How hard this one challenge should read, independent of its wire type.
	 * Derived from the item's own {@link SlotDifficulty ladder level}, shifted by
	 * how the learner is doing overall and pulled down a rung when this word was
	 * just missed — see {@link planSlots}.
	 */
	difficulty: SlotDifficulty;
}

/**
 * Types where the answer is visible somewhere on screen: the learner recognizes
 * or picks rather than produces. Safe for a word met yesterday, because a wrong
 * answer still says something about the word rather than about the format.
 */
const RECOGNITION_KINDS: readonly SlotKind[] = [
	{ type: 'recognize-mc' },
	{ type: 'produce-mc' },
	{ type: 'translate-to-native' },
	{ type: 'spot-error' }
];

/**
 * Types the learner has to produce into, but with the material in front of
 * them. Both are demand 1 on the stored side (`$lib/challenges`' `demand`):
 * `word-order` gives the words and withholds only their order, a banked cloze
 * gives the candidate words and withholds which one fits. Neither is a question
 * a word met yesterday can answer — and pretending a banked cloze is
 * recognition was worse than merely mistaken, because the planner would then
 * happily write one for a level-1 word and the *session* planner, reading the
 * same stored demand, would decline to serve it for weeks.
 */
const YOUNG_PRODUCTION_KINDS: readonly SlotKind[] = [
	{ type: 'word-order' },
	{ type: 'cloze', bank: true }
];

const SOLID_PRODUCTION_KINDS: readonly SlotKind[] = [
	...YOUNG_PRODUCTION_KINDS,
	{ type: 'translate-to-target' },
	{ type: 'cloze', bank: false }
];

/**
 * Every kind the planner can ask for.
 *
 * This is the membership list that matters now: a wire type registered in
 * `./challenge-types` but named nowhere above is a type the model is told about
 * and never asked for, which used to be impossible — the model chose. So it is
 * pinned against the registry in `challenge-types/registry.test.ts`, and adding
 * a wire type means adding it here too.
 */
export const PLANNABLE_KINDS: readonly SlotKind[] = [
	...RECOGNITION_KINDS,
	...SOLID_PRODUCTION_KINDS
];

/** Stable identity of a kind, for "has this item had one of these already?". */
function kindKey(kind: SlotKind): string {
	return kind.bank === undefined ? kind.type : `${kind.type}:${kind.bank ? 'bank' : 'free'}`;
}

/**
 * The production types a word at this ladder level may be asked for.
 * Recognition is always allowed; production opens up as the word gets
 * stronger, at the same two rungs (`level >= 4`, `level >= 2`) the session
 * planner's floors correspond to — level 1 is `maturityOf`'s `'new'`, 2-3 are
 * `'young'`, 4-5 are `'solid'` — so a batch is not full of challenges the
 * planner will then decline to serve for weeks. A level-1 word therefore gets
 * no cloze at all: even the banked one is demand 1.
 */
export function allowedKinds(level: ReviewItemRef['level']): {
	recognition: readonly SlotKind[];
	production: readonly SlotKind[];
} {
	// Undefined is a caller with no SRS state to judge by — the cautious end,
	// same as level 1.
	if ((level ?? 1) >= 4) {
		return { recognition: RECOGNITION_KINDS, production: SOLID_PRODUCTION_KINDS };
	}
	if ((level ?? 1) >= 2) {
		return { recognition: RECOGNITION_KINDS, production: YOUNG_PRODUCTION_KINDS };
	}
	return { recognition: RECOGNITION_KINDS, production: [] };
}

/** The accuracy band {@link productionShare} and the per-slot difficulty shift both read. */
const ACCURACY_FLOOR = 0.7;
const ACCURACY_CEILING = 0.85;

/**
 * What share of the lesson should be production, given how the learner is
 * currently doing. Linear between the two bounds that used to be a prompt-side
 * cliff: 0.2 at {@link ACCURACY_FLOOR} and below, up to 0.6 at
 * {@link ACCURACY_CEILING} and above, so a learner drifting from 0.72 to 0.78
 * sees the mix drift with them instead of jumping a whole band at once.
 */
export function productionShare(recentAccuracy: number | undefined): number {
	if (recentAccuracy === undefined || !Number.isFinite(recentAccuracy)) return 0.4;
	const clamped = Math.min(ACCURACY_CEILING, Math.max(ACCURACY_FLOOR, recentAccuracy));
	const progress = (clamped - ACCURACY_FLOOR) / (ACCURACY_CEILING - ACCURACY_FLOOR);
	return 0.2 + progress * (0.6 - 0.2);
}

/** One position in the lesson: whose turn it is, and any constraint on it. */
interface Demand {
	item: ReviewItemRef;
	/**
	 * Set on the extra slot a just-failed word earns. `'(skipped)'` means the
	 * format itself was too demanding, so that slot must be recognition whatever
	 * the word's level would otherwise allow.
	 */
	recognitionOnly?: boolean;
}

/** The review items a recent mistake names, in review-item order, deduped. */
function mistakenItems(
	items: readonly ReviewItemRef[],
	mistakes: readonly RecentMistake[] | undefined
): { item: ReviewItemRef; skipped: boolean }[] {
	if (!mistakes?.length) return [];
	const byTerm = new Map<string, RecentMistake>();
	for (const mistake of mistakes) {
		const key = termKey(mistake.term);
		if (!byTerm.has(key)) byTerm.set(key, mistake);
	}
	const out: { item: ReviewItemRef; skipped: boolean }[] = [];
	for (const item of items) {
		const mistake = byTerm.get(termKey(item.term));
		if (mistake) out.push({ item, skipped: mistake.gave.trim() === '(skipped)' });
	}
	return out;
}

/**
 * How many slots one word can usefully take: one per distinct kind its level
 * allows, and no more.
 *
 * Without this the round-robin will happily deal fourteen slots onto a single
 * review item, of which only eight can be different questions — the rest repeat
 * a format the learner has already answered in this same lesson, which is worse
 * than a shorter lesson. A count is a ceiling, not a quota.
 */
function capacityOf(item: ReviewItemRef): number {
	const { recognition, production } = allowedKinds(item.level);
	return new Set([...recognition, ...production].map(kindKey)).size;
}

/**
 * Whose turn each slot is, before any type is chosen.
 *
 * Plain round-robin over the review items, so the lesson spreads itself evenly
 * and no word is asked about three times before another is asked about once —
 * except that a word in `recentMistakes` gets one extra turn, inserted right
 * after the first pass. That is the local half of the old "every term in
 * recentMistakes gets one more challenge" rule; the *different format* half
 * falls out of the type picker, which prefers a kind the item has not had yet.
 *
 * A word stops taking turns once it has reached its {@link capacityOf}, and the
 * whole plan stops as soon as a full pass adds nothing — so a big `count` over
 * few words comes back short rather than repetitive.
 */
function demands(args: BatchArgs, total: number): Demand[] {
	const items = args.reviewItems;
	const out: Demand[] = [];
	if (items.length === 0 || total <= 0) return out;

	const capacity = new Map(items.map((item) => [item.id, capacityOf(item)] as const));
	const taken = new Map<string, number>();
	const take = (item: ReviewItemRef, recognitionOnly?: boolean): boolean => {
		const used = taken.get(item.id) ?? 0;
		if (used >= (capacity.get(item.id) ?? 0)) return false;
		taken.set(item.id, used + 1);
		out.push({ item, ...(recognitionOnly === undefined ? {} : { recognitionOnly }) });
		return true;
	};

	const extras = mistakenItems(items, args.recentMistakes);
	for (let pass = 0; out.length < total; pass++) {
		let added = 0;
		for (const item of items) {
			if (out.length >= total) break;
			if (take(item)) added++;
		}
		if (pass === 0) {
			for (const extra of extras) {
				if (out.length >= total) break;
				if (take(extra.item, extra.skipped)) added++;
			}
		}
		// Every word is at capacity: this lesson is as long as it can honestly be.
		if (added === 0) break;
	}
	return out;
}

/**
 * The whole-lesson accuracy shift applied to every slot's difficulty level: -1
 * below {@link ACCURACY_FLOOR}, +1 at or above {@link ACCURACY_CEILING}, 0
 * between them.
 *
 * A three-valued step on the two named bounds, and deliberately not a rounded
 * interpolation: the ladder it moves has five rungs, so there is nothing
 * between -1 and 0 to express, and an arithmetic version only obscures where it
 * actually steps. (It did: `Math.round((acc - 0.7) * 4)` clamped its *output*,
 * which put the real seams at 0.575 and 0.825 — neither of them a number this
 * module names anywhere.) The bounds are the same two {@link productionShare}
 * interpolates between, which is the point: one accuracy band, read two ways —
 * continuously for the mix, in whole rungs for the difficulty.
 */
function accuracyShift(recentAccuracy: number | undefined): -1 | 0 | 1 {
	if (recentAccuracy === undefined || !Number.isFinite(recentAccuracy)) return 0;
	if (recentAccuracy < ACCURACY_FLOOR) return -1;
	if (recentAccuracy >= ACCURACY_CEILING) return 1;
	return 0;
}

/** `level` folded to the closed `1..5` range every {@link Slot.difficulty} lives in. */
function clampDifficulty(level: number): SlotDifficulty {
	return Math.max(1, Math.min(5, Math.round(level))) as SlotDifficulty;
}

/**
 * How many distinct kinds one lesson opens before it starts reusing them.
 *
 * A kind is a *request*: every challenge of one kind travels in one brief, with
 * one system prompt explaining that one type. So the number of kinds a plan
 * names is the number of round trips a lesson costs, and a twenty-challenge
 * lesson that touched all eight kinds paid eight prompts to ask two or three
 * questions each. Four is the smallest number that still varies a lesson: a
 * word never repeats a format either way (that is {@link pickKind}'s freshness
 * rule, which outranks this), and which four a lesson opens still moves with
 * the rng, so two lessons in a row do not look alike.
 */
export const MAX_LESSON_KINDS = 4;

/**
 * Picks one of `candidates` for this item, or `undefined` when it has had them
 * all.
 *
 * Freshness for the *word* comes first and is absolute: a lesson never asks one
 * word the same kind twice, and a word that has exhausted a group falls through
 * to the other rather than repeating itself. Since {@link capacityOf} caps a
 * word at exactly the number of kinds it allows, returning `undefined` from
 * both groups can only happen for a word already at capacity — which is a word
 * `demands` has stopped dealing slots to.
 *
 * Among the fresh candidates, a lesson that has already opened
 * {@link MAX_LESSON_KINDS} kinds prefers one of those, so the plan stays a few
 * long briefs rather than many short ones. It only opens a new kind when none
 * of the open ones is both allowed for this word and fresh for it.
 */
function pickKind(
	candidates: readonly SlotKind[],
	used: Set<string>,
	open: Set<string>,
	rng: () => number
): SlotKind | undefined {
	const fresh = candidates.filter((kind) => !used.has(kindKey(kind)));
	if (fresh.length === 0) return undefined;
	const reusable = open.size >= MAX_LESSON_KINDS ? fresh.filter((k) => open.has(kindKey(k))) : [];
	const pool = reusable.length > 0 ? reusable : fresh;
	return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * Turns a batch request into the explicit list of challenges to generate.
 *
 * The count is the caller's (`count`, else two per review item), clamped to
 * `MAX_BATCH_CHALLENGES` and to what the words can carry ({@link capacityOf}).
 * Types are chosen per slot: the group — recognition or production — is decided
 * across the whole lesson so the mix lands near {@link productionShare} *of the
 * slots that could be production at all*, and the concrete type is then drawn
 * from what the word's ladder level allows, preferring one that word has not had
 * in this lesson.
 *
 * A word whose level allows no production simply takes recognition instead; it
 * still counts as a filled slot, which is why an all-level-1 lesson is all
 * recognition rather than short — and its slots are kept out of the production
 * budget's denominator, so a mixed lesson does not spend the whole budget on
 * the two mature words in it.
 *
 * Each slot also gets a `difficulty`, 1..5: the item's own {@link
 * ReviewItemRef.level}, shifted by {@link accuracyShift} (how the learner is
 * doing across the whole lesson) and pulled down one rung where
 * `recentMistakes` says so — the local replacement for the two prompt-side
 * accuracy cliffs and the "write it EASIER than last time" rule the prompt used
 * to lean on alone. The rung is never sent: `./generate` asks the wire def what
 * it *means* for the type being written, and sends those counts instead.
 *
 * *Where* a mistake reaches depends on what kind of mistake it was, and the two
 * are not the same claim. A genuine wrong answer is evidence about the **word**:
 * the learner tried and could not, so every slot about that word this lesson is
 * written a rung easier. A `'(skipped)'` is evidence about the **format** — "I
 * could not even attempt this one" — and {@link demands} already answers that by
 * making the extra slot recognition-only. Pulling the word's other slots down
 * too would shorten every recognize-mc about a word whose only sin was meeting a
 * production format a few days early, so a skip moves that one extra slot and
 * nothing else.
 */
export function planSlots(args: BatchArgs, rng: () => number = Math.random): Slot[] {
	const requested = args.count ?? defaultChallengeCount(args.reviewItems.length);
	const total = Math.max(0, Math.min(requested, MAX_BATCH_CHALLENGES));
	const queue = demands(args, total);

	const share = productionShare(args.recentAccuracy);
	const shift = accuracyShift(args.recentAccuracy);
	const skippedById = new Map(
		mistakenItems(args.reviewItems, args.recentMistakes).map(
			({ item, skipped }) => [item.id, skipped] as const
		)
	);
	const usedByItem = new Map<string, Set<string>>();
	// The kinds this lesson has opened, across every word — the thing
	// `MAX_LESSON_KINDS` bounds, and so the number of requests it will cost.
	const openKinds = new Set<string>();
	const slots: Slot[] = [];
	let production = 0;
	let eligible = 0;

	for (const demand of queue) {
		const used = usedByItem.get(demand.item.id) ?? new Set<string>();
		usedByItem.set(demand.item.id, used);

		const allowed = allowedKinds(demand.item.level);
		// Charged against the slots that could actually pay it, not against the
		// whole lesson: a level-1 word's slot can never be production, and counting
		// it in the denominator hands its share to whichever words *can* produce —
		// four new words beside two mature ones made the mature two 100% production.
		const canProduce = !demand.recognitionOnly && allowed.production.length > 0;
		// The `+ 0.5` is a largest-remainder rounding: a slot flips to production
		// only once the running share has fallen a *whole* eligible slot behind the
		// target, which keeps low shares from spending their first slot on
		// production and makes the resulting mix exactly `share` at every length.
		const wantProduction = canProduce && production + 0.5 < share * (eligible + 1);

		const group = wantProduction ? allowed.production : allowed.recognition;
		const fromGroup = pickKind(group, used, openKinds, rng);
		// The word has had every kind in the group it was dealt, so it takes one
		// from the other rather than answering the same format twice — which is
		// what makes {@link capacityOf}'s count of *distinct* kinds the real
		// ceiling. A `recognitionOnly` slot never crosses: the skip it answers
		// said that format was too much for this word, so production is not open
		// to it however short of recognition kinds it runs.
		const other = wantProduction ? allowed.recognition : canProduce ? allowed.production : [];
		const kind = fromGroup ?? pickKind(other, used, openKinds, rng);
		if (!kind) continue;

		used.add(kindKey(kind));
		openKinds.add(kindKey(kind));
		if (canProduce) eligible++;
		// Only a slot that really became production is charged to the budget: the
		// fallback above hands back a recognition kind, and counting it as
		// production would suppress a later slot that could genuinely have been one.
		if (wantProduction && fromGroup) production++;
		// A wrong answer moves every slot about the word; a skip moves only the
		// extra slot it earned, which `demands` marks `recognitionOnly`.
		const skipped = skippedById.get(demand.item.id);
		const missed = skipped === false || (skipped === true && demand.recognitionOnly === true);
		const difficulty = clampDifficulty((demand.item.level ?? 1) + shift - (missed ? 1 : 0));
		slots.push({ itemId: demand.item.id, term: demand.item.term, difficulty, ...kind });
	}

	return slots;
}

/*
 * How big a lesson is, is a slot-planning question, so both constants live here
 * and `./generate` re-exports them under the names its callers have always used.
 * The dependency runs one way — `./generate` imports this module, this module
 * imports only *types* back — so there is no cycle to reason about.
 */

/** Hard ceiling on challenges per lesson, so one plan can never run away. */
export const MAX_BATCH_CHALLENGES = 20;

/**
 * Default lesson size: two challenges per word the lesson is about — one
 * recognition, one production, which is the shape a session wants to serve.
 */
export function defaultChallengeCount(reviewItems: number): number {
	return Math.min(MAX_BATCH_CHALLENGES, Math.max(1, reviewItems * 2));
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Challenges one request may ask for. Small on purpose: a model writing six
 * challenges of one type keeps the rules and the ones it has already written in
 * mind, and one writing twenty across seven types does not.
 */
export const REQUEST_ITEMS = 6;

/**
 * How many requests may be in flight at once. Three is enough to hide most of
 * the latency of a four-request lesson without asking a rate-limited key to
 * serve a whole lesson simultaneously.
 */
export const REQUEST_CONCURRENCY = 3;

/** One challenge to write, as its own request's brief spells it out. */
export interface RequestItem {
	/**
	 * Where this challenge sits in the plan — and so in the finished lesson.
	 * Requests settle in whatever order the network answers them, and the merge
	 * puts them back in plan order by this number.
	 */
	index: number;
	/** The review item's id — the same id the resolver will accept back. */
	itemId: string;
	/** The word itself, so the brief names it without a second lookup. */
	term: string;
	/** The rung this item's parameters are computed from. Never sent as itself. */
	difficulty: SlotDifficulty;
}

/** One request: one wire type, and the handful of challenges to write in it. */
export interface TypeRequest {
	kind: SlotKind;
	items: RequestItem[];
}

/**
 * Cuts a plan into requests, one per kind.
 *
 * This is the shape of the whole design: a request is about **one** wire type,
 * so its system prompt explains that one type, its JSON schema admits that one
 * type, and its payload is a list of words with the numbers that type is sized
 * by. The model is never handed a mixed list to sort out, never told what the
 * other six types are, and never asked to read an abstract difficulty.
 *
 * Requests come out in first-appearance order, and a kind with more than
 * {@link REQUEST_ITEMS} challenges spills into a second request of the same
 * kind. Every item within a request is a different word by construction: a word
 * never gets the same kind twice in one lesson (see {@link pickKind}).
 */
export function groupIntoRequests(slots: readonly Slot[]): TypeRequest[] {
	const openByKind = new Map<string, TypeRequest>();
	const requests: TypeRequest[] = [];

	slots.forEach((slot, index) => {
		const item: RequestItem = {
			index,
			itemId: slot.itemId,
			term: slot.term,
			difficulty: slot.difficulty
		};
		const key = kindKey(slot);
		const open = openByKind.get(key);
		if (open && open.items.length < REQUEST_ITEMS) {
			open.items.push(item);
			return;
		}
		const request: TypeRequest = {
			kind: slot.bank === undefined ? { type: slot.type } : { type: slot.type, bank: slot.bank },
			items: [item]
		};
		openByKind.set(key, request);
		requests.push(request);
	});

	return requests;
}
