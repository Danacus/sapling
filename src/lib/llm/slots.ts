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
 * about and which wire type it has to be. The model is then handed a short,
 * explicit list and asked only to fill it — which is a much smaller question,
 * and one it answers far more reliably. What stays in the prompt is the part
 * that is genuinely about *content*: how long an answer should be, how hard a
 * sentence should read, what a lesson should sound like.
 *
 * Everything here is pure and deterministic given an injectable `rng`, so a plan
 * can be replayed in a test without a network or a clock.
 *
 * The one input it reads about a word is `maturity` — the same three buckets the
 * session planner gates *serving* on (`maturityOf` in `$lib/session/progression`).
 * A finer per-item difficulty signal is expected to land here later; it belongs
 * inside {@link allowedKinds} and {@link productionShare}, and callers of
 * {@link planSlots} would not have to change.
 */

import { termKey } from '$lib/text';
import type { WireType } from './challenge-types';
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
export interface SlotKind {
	type: WireType;
	/** `cloze` only: `true` asks for `distractorWords`, `false` forbids them. */
	bank?: boolean;
}

/** One challenge to generate: the word it is about, and the shape it takes. */
export interface Slot extends SlotKind {
	/** The review item's id — the same id the resolver will accept back. */
	itemId: string;
	/** The word itself, so a chunk's payload can name it without a second lookup. */
	term: string;
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
	{ type: 'cloze', bank: true },
	{ type: 'spot-error' }
];

/**
 * Types the learner has to produce into. `word-order` is the gentle one — the
 * words are given, only the order is not — which is why a `young` word gets it
 * and a `new` word does not.
 */
const YOUNG_PRODUCTION_KINDS: readonly SlotKind[] = [{ type: 'word-order' }];

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
 * The production types a word at this maturity may be asked for. Recognition is
 * always allowed; production opens up as the word gets stronger, on the same
 * floors the session planner uses to decide what it is willing to *serve*, so a
 * batch is not full of challenges the planner will then decline for weeks.
 */
export function allowedKinds(maturity: ReviewItemRef['maturity']): {
	recognition: readonly SlotKind[];
	production: readonly SlotKind[];
} {
	if (maturity === 'solid')
		return { recognition: RECOGNITION_KINDS, production: SOLID_PRODUCTION_KINDS };
	if (maturity === 'young') {
		return { recognition: RECOGNITION_KINDS, production: YOUNG_PRODUCTION_KINDS };
	}
	// `new`, and anything the caller had no SRS state to judge by.
	return { recognition: RECOGNITION_KINDS, production: [] };
}

/**
 * What share of the lesson should be production, given how the learner is
 * currently doing. The thresholds are the ones that used to be prose in the
 * prompt: below 0.7 favour recognition, above 0.85 lean into production.
 */
export function productionShare(recentAccuracy: number | undefined): number {
	if (recentAccuracy === undefined || !Number.isFinite(recentAccuracy)) return 0.4;
	if (recentAccuracy < 0.7) return 0.2;
	if (recentAccuracy > 0.85) return 0.6;
	return 0.4;
}

/** One position in the lesson: whose turn it is, and any constraint on it. */
interface Demand {
	item: ReviewItemRef;
	/**
	 * Set on the extra slot a just-failed word earns. `'(skipped)'` means the
	 * format itself was too demanding, so that slot must be recognition whatever
	 * the maturity would otherwise allow.
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
 * Whose turn each slot is, before any type is chosen.
 *
 * Plain round-robin over the review items, so the lesson spreads itself evenly
 * and no word is asked about three times before another is asked about once —
 * except that a word in `recentMistakes` gets one extra turn, inserted right
 * after the first pass. That is the local half of the old "every term in
 * recentMistakes gets one more challenge" rule; the *different format* half
 * falls out of the type picker, which prefers a kind the item has not had yet.
 */
function demands(args: BatchArgs, total: number): Demand[] {
	const items = args.reviewItems;
	const out: Demand[] = [];
	if (items.length === 0 || total <= 0) return out;

	const extras = mistakenItems(items, args.recentMistakes);
	for (let pass = 0; out.length < total; pass++) {
		for (const item of items) {
			if (out.length >= total) break;
			out.push({ item });
		}
		if (pass === 0) {
			for (const extra of extras) {
				if (out.length >= total) break;
				out.push({ item: extra.item, recognitionOnly: extra.skipped });
			}
		}
	}
	return out;
}

/** Picks one of `candidates`, preferring the ones this item has not had yet. */
function pickKind(
	candidates: readonly SlotKind[],
	used: Set<string>,
	rng: () => number
): SlotKind | undefined {
	if (candidates.length === 0) return undefined;
	const fresh = candidates.filter((kind) => !used.has(kindKey(kind)));
	const pool = fresh.length > 0 ? fresh : candidates;
	return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/**
 * Turns a batch request into the explicit list of challenges to generate.
 *
 * The count is the caller's (`count`, else two per review item), clamped to
 * `MAX_BATCH_CHALLENGES`. Types are chosen per slot: the group — recognition or
 * production — is decided across the whole lesson so the mix lands near
 * {@link productionShare}, and the concrete type is then drawn from what the
 * word's maturity allows, preferring one that word has not had in this lesson.
 *
 * A word whose maturity allows no production simply takes recognition instead;
 * it still counts as a filled slot, which is why an all-`new` lesson is all
 * recognition rather than short.
 */
export function planSlots(args: BatchArgs, rng: () => number = Math.random): Slot[] {
	const requested = args.count ?? defaultChallengeCount(args.reviewItems.length);
	const total = Math.max(0, Math.min(requested, MAX_BATCH_CHALLENGES));
	const queue = demands(args, total);

	const share = productionShare(args.recentAccuracy);
	const usedByItem = new Map<string, Set<string>>();
	const slots: Slot[] = [];
	let production = 0;

	for (const demand of queue) {
		const used = usedByItem.get(demand.item.id) ?? new Set<string>();
		usedByItem.set(demand.item.id, used);

		const allowed = allowedKinds(demand.item.maturity);
		// The `+ 0.5` is a largest-remainder rounding: a slot flips to production
		// only once the running share has fallen a *whole* slot behind the target,
		// which keeps low shares from spending their first slot on production and
		// makes the resulting mix exactly `share` at every length.
		const wantProduction =
			!demand.recognitionOnly &&
			allowed.production.length > 0 &&
			production + 0.5 < share * (slots.length + 1);

		const group = wantProduction ? allowed.production : allowed.recognition;
		const kind = pickKind(group, used, rng) ?? pickKind(allowed.recognition, used, rng);
		if (!kind) continue;

		used.add(kindKey(kind));
		if (wantProduction) production++;
		slots.push({ itemId: demand.item.id, term: demand.item.term, ...kind });
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
/* Chunking                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Slots per request. Small on purpose: the whole point of the rewrite is that a
 * model writing five challenges about three words keeps the rules and the
 * earlier challenges in mind, and one writing twenty about twelve does not.
 */
export const CHUNK_SLOTS = 5;

/** Distinct review items one request may be about. Fewer words, tighter lesson. */
export const CHUNK_ITEMS = 3;

/**
 * How many chunk requests may be in flight at once. Three is enough to hide most
 * of the latency of a four-or-five chunk lesson without asking a rate-limited
 * key to serve a whole lesson simultaneously.
 */
export const CHUNK_CONCURRENCY = 3;

/** One request's worth of work: the slots to fill and the words they are about. */
export interface SlotChunk {
	slots: Slot[];
	/** The review items those slots name, in first-appearance order. */
	reviewItems: ReviewItemRef[];
}

/**
 * Partitions a plan into requests.
 *
 * Slots are grouped **by item** rather than cut where the round-robin happens to
 * fall: a request about three words and everything the lesson wants to say about
 * them is a coherent, short brief, whereas five slots about five different words
 * is the same scattered question the one-big-call design was asking. An item
 * with more slots than {@link CHUNK_SLOTS} spills into the next chunk rather
 * than pushing one over the cap.
 *
 * Chunk order — and within a chunk, slot order — is the lesson order the merged
 * result is assembled in, so a completion that comes back first does not jump
 * the queue.
 */
export function chunkSlots(slots: readonly Slot[], items: readonly ReviewItemRef[]): SlotChunk[] {
	const byItem = new Map<string, Slot[]>();
	for (const slot of slots) {
		const bucket = byItem.get(slot.itemId);
		if (bucket) bucket.push(slot);
		else byItem.set(slot.itemId, [slot]);
	}
	const itemById = new Map(items.map((item) => [item.id, item] as const));

	const chunks: SlotChunk[] = [];
	let current: SlotChunk | undefined;

	for (const [itemId, itemSlots] of byItem) {
		const item = itemById.get(itemId);
		let i = 0;
		while (i < itemSlots.length) {
			const remaining = itemSlots.length - i;
			const holds = (chunk: SlotChunk | undefined): boolean =>
				!!chunk?.reviewItems.some((r) => r.id === itemId);
			const full =
				!current ||
				current.slots.length + remaining > CHUNK_SLOTS ||
				(current.reviewItems.length >= CHUNK_ITEMS && !holds(current));
			// A word's slots move together — a chunk is a brief about a few words,
			// and half a word in one request and half in another is exactly the
			// scattered question this design exists to stop asking. The one exception
			// is a word with more slots than a chunk holds: it has to be split
			// whatever we do, and a fresh chunk would be just as full, so it spills.
			if (full && (!current || current.slots.length > 0)) {
				current = { slots: [], reviewItems: [] };
				chunks.push(current);
			}
			const chunk = current as SlotChunk;
			if (item && !holds(chunk)) chunk.reviewItems.push(item);
			const take = Math.min(remaining, Math.max(1, CHUNK_SLOTS - chunk.slots.length));
			chunk.slots.push(...itemSlots.slice(i, i + take));
			i += take;
		}
	}

	return chunks;
}
