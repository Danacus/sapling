/**
 * Requests: the shape one generation call takes, and how a list of wants is
 * cut into them.
 *
 * This layer plans nothing. It is handed a list of **wants** — each one word,
 * one kind of challenge, one difficulty rung — and its whole job is to turn
 * that list into calls the model can answer well: {@link groupIntoRequests}
 * cuts it by *kind*, so each request asks for one wire type and nothing else.
 * The model is handed a list of words and a couple of counts and asked to
 * write six of the same thing, which is a much smaller question than a mixed
 * brief and one it answers far more reliably.
 *
 * *Which* wants there are is the session's decision (`$lib/session/topup`),
 * because only the session can see the pool: a want exists where a word the
 * learner is about to meet has no fresh challenge of a kind it can bear. The
 * only thing this module knows about a kind beyond its wire type is the
 * {@link PlannableKind.demand} tier it will report once stored — that is what
 * lets the session ask for kinds a word can bear without importing anything
 * about how the challenge is written.
 *
 * A want's `difficulty` never leaves this side either: `./generate` asks the
 * wire def what the rung *means* for the type being written (`params`), and
 * sends those counts — a sentence length, a bank size, a tile count.
 */

import type { Demand } from '$lib/challenges/types';
import type { Challenge } from '$lib/types';
import { WIRE_TYPE_DEFS } from './challenge-types';
import type { DifficultyRung, SizingKind, WireType } from './challenge-types';

/**
 * A wire type together with the one presentation choice that changes how hard
 * it is: whether a cloze comes with a word bank.
 *
 * The bank is a type-level decision, not a content one — "cloze WITH
 * distractorWords" and "cloze without" are two different exercises for two
 * different stages of a word — so it is decided by whoever asks, and told to
 * the model, rather than left for it to guess.
 */
export interface ChallengeKind extends SizingKind {
	type: WireType;
	/** `cloze` only: `true` asks for `distractorWords`, `false` forbids them. */
	bank?: boolean;
}

/**
 * A kind the session may ask for, with the demand tier its stored challenge
 * reports (`$lib/challenges`' `demand`): 0 recognition, 1 constrained
 * production, 2 free production.
 *
 * The tier is restated here rather than resolved from a fixture at runtime so
 * the session can read it without building a challenge — and it is pinned
 * against every def's own resolved fixtures in `challenge-types/registry.test.ts`,
 * so a kind whose stated tier drifts from what its resolver actually writes
 * fails the suite. A banked cloze is demand 1 (the words are given, which one
 * fits is not) and a bankless one demand 2, which is why cloze appears twice.
 */
export interface PlannableKind extends ChallengeKind {
	readonly demand: Demand;
}

/**
 * Every kind the session can ask for.
 *
 * This is the membership list that matters: a wire type registered in
 * `./challenge-types` but named nowhere here is a type that can be prompted and
 * exampled and is never asked for. It is pinned against the registry in
 * `challenge-types/registry.test.ts`, and adding a wire type means adding it
 * here too, with the tier its resolved challenge reports.
 */
export const PLANNABLE_KINDS: readonly PlannableKind[] = [
	{ type: 'recognize-mc', demand: 0 },
	{ type: 'produce-mc', demand: 0 },
	{ type: 'translate-to-native', demand: 0 },
	{ type: 'spot-error', demand: 0 },
	{ type: 'word-order', demand: 1 },
	{ type: 'cloze', bank: true, demand: 1 },
	{ type: 'translate-to-target', demand: 2 },
	{ type: 'cloze', bank: false, demand: 2 }
];

/** Stable identity of a kind: the key a pool is grouped by and a plan cut on. */
export function kindKey(kind: ChallengeKind): string {
	return kind.bank === undefined ? kind.type : `${kind.type}:${kind.bank ? 'bank' : 'free'}`;
}

/** A kind without its `demand`, for the places that only carry the identity. */
export function bareKind(kind: ChallengeKind): ChallengeKind {
	return kind.bank === undefined ? { type: kind.type } : { type: kind.type, bank: kind.bank };
}

/** Stored `{type, direction}` → the wire def that writes it, built once. */
const defByStored: ReadonlyMap<string, (typeof WIRE_TYPE_DEFS)[number]> = new Map(
	WIRE_TYPE_DEFS.map((def) => [`${def.stored.type}|${def.stored.direction}`, def] as const)
);

/**
 * The kind a stored challenge *is* — the inverse of generating one.
 *
 * Read off the stored `{type, direction}` each wire def declares (which is what
 * tells the two multiple-choice wire types and the two translate wire types
 * apart) plus, for a cloze, whether a word bank survived. Two callers need the
 * same answer: `./generate` checks a reply against the kind it asked for, and
 * the session counts what kinds a word already has in the pool. `undefined` for
 * a `match-pairs` round, which no wire type writes.
 */
export function kindOf(challenge: Challenge): ChallengeKind | undefined {
	const def = defByStored.get(`${challenge.type}|${challenge.direction}`);
	if (!def) return undefined;
	if (def.type !== 'cloze') return { type: def.type };
	const banked = 'wordBank' in challenge && (challenge.wordBank?.length ?? 0) > 0;
	return { type: 'cloze', bank: banked };
}

/** The word a want is about: the id the resolver accepts back, and what the model reads. */
export interface WantItem {
	id: string;
	term: string;
	meaning: string;
}

/**
 * One challenge to generate: the word it is about, the kind it takes, and how
 * hard to write it.
 *
 * The rung is the word's own ladder level (`difficultyLevelOf` in
 * `$lib/session/progression`, a bare `1..5` here since `$lib/llm` never reaches
 * into `$lib/session`). It is never sent as itself — see `WireTypeDef.params`.
 */
export interface Want {
	item: WantItem;
	kind: ChallengeKind;
	difficulty: DifficultyRung;
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
 * the latency of a four-request top-up without asking a rate-limited key to
 * serve all of it simultaneously.
 */
export const REQUEST_CONCURRENCY = 3;

/** One request: one wire type, and the handful of challenges to write in it. */
export interface TypeRequest {
	kind: ChallengeKind;
	wants: Want[];
}

/**
 * Cuts a list of wants into requests, one per kind.
 *
 * This is the shape of the whole design: a request is about **one** wire type,
 * so its system prompt explains that one type, its JSON schema admits that one
 * type, and its payload is a list of words with the numbers that type is sized
 * by. The model is never handed a mixed list to sort out, never told what the
 * other six types are, and never asked to read an abstract difficulty.
 *
 * Requests come out in first-appearance order, and a kind with more than
 * {@link REQUEST_ITEMS} wants spills into a second request of the same kind.
 * Every item within a request is a different word: a reply is matched back to
 * its brief by the word each challenge cites, so a second want of the same kind
 * for the same word could never be told from the first, and is dropped here
 * rather than asked for twice.
 */
export function groupIntoRequests(wants: readonly Want[]): TypeRequest[] {
	const openByKind = new Map<string, TypeRequest>();
	const seen = new Set<string>();
	const requests: TypeRequest[] = [];

	for (const want of wants) {
		const key = kindKey(want.kind);
		const identity = `${want.item.id}|${key}`;
		if (seen.has(identity)) continue;
		seen.add(identity);

		const open = openByKind.get(key);
		if (open && open.wants.length < REQUEST_ITEMS) {
			open.wants.push(want);
			continue;
		}
		const request: TypeRequest = { kind: bareKind(want.kind), wants: [want] };
		openByKind.set(key, request);
		requests.push(request);
	}

	return requests;
}
