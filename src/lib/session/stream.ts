/**
 * The practice stream (`docs/challenge-difficulty.md` §11): one challenge at a
 * time until the learner stops, each picked against the store as it is *now*
 * — after the last answer's review, skill and serve stamp have landed — by
 * Rust (`crates/sapling-challenges`' `stream.rs`, through the engine's
 * {@link nextPick}). Nothing is planned ahead, so there is nothing to throw
 * away when the learner stops: answers are written as they happen
 * (`applyResult`), and what they never reached was never stamped.
 *
 * This module holds only what a stream remembers between picks — the ids it
 * has shown, the learner's pace, how many early-word challenges have passed
 * since the last match round, how long the last batch took — and reads the
 * store for each pick. It makes no write and starts no task: {@link
 * PracticeStream.refill} says what a `top-up` would write for, and the page
 * starts it, because `$lib/session` never imports `$lib/tasks`.
 */

import { getAllItems, getDifficultyParts, getPool, getProfile } from '$lib/db';
import { storedDefFor } from '$lib/challenges/types';
import type { Challenge, KnowledgeItem, MatchPairsChallenge } from '$lib/types';
import {
	MATCH_PAIRS_EVERY,
	isEarlyChallenge,
	lowWaterMark,
	matchRound,
	planTopUp,
	streamHead,
	type SessionPick
} from './engine';
import { servingFor, type DeviceServing } from './serving';

/** What the stream serves next. */
export type StreamStep =
	| ({ kind: 'challenge' } & SessionPick)
	| { kind: 'round'; challenge: MatchPairsChallenge }
	/**
	 * The most urgent word has nothing available: the stream waits for a
	 * refill, unless one was already asked for it — then no batch will help.
	 */
	| { kind: 'blocked'; asked: boolean };

/** What a stream's refill writes for: the `top-up` task's `served`, `asked` and `limit`. */
export interface RefillScope {
	served: string[];
	asked: string[];
	limit: number;
}

export interface PracticeStreamOptions {
	/** Epoch ms for each read; `Date.now` when absent. */
	clock?: () => number;
	/** This device's help-level bounds; read from the preferences when absent. */
	device?: DeviceServing;
	/** Replays the match rounds' draws. */
	seed?: number;
}

/** How many recent answers the pace is the median of. */
const PACE_WINDOW = 10;

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

export class PracticeStream {
	readonly #clock: () => number;
	readonly #device: DeviceServing | undefined;
	#seed: number | undefined;
	readonly #served = new Set<string>();
	/**
	 * Words a refill was asked for and nothing has been served of since: never
	 * asked for again, so rows that came back not fitting, a word a batch
	 * dropped and a failed batch all end at one request.
	 */
	readonly #asked = new Set<string>();
	readonly #paces: number[] = [];
	#earlySinceRound = 0;
	#batchMs: number | undefined;
	#items: KnowledgeItem[] = [];

	constructor(opts: PracticeStreamOptions = {}) {
		this.#clock = opts.clock ?? Date.now;
		this.#device = opts.device;
		this.#seed = opts.seed;
	}

	/** Every word as of the last read: what the page tokenizes and speaks around. */
	get items(): KnowledgeItem[] {
		return this.#items;
	}

	async #read() {
		const [pool, items, parts, profile] = await Promise.all([
			getPool(),
			getAllItems(),
			getDifficultyParts(),
			getProfile()
		]);
		this.#items = items;
		const serving = servingFor(profile, parts, this.#device);
		return { pool, items, serving, now: this.#clock(), served: [...this.#served] };
	}

	/**
	 * The next thing to show: the head word's challenge at its help level, a
	 * free match round when enough early-word challenges have passed and there
	 * is a challenge to follow it, or `blocked` while the head has nothing.
	 */
	async next(): Promise<StreamStep> {
		const { pool, items, serving, now, served } = await this.#read();
		const head = streamHead(pool, items, now, { serving, served });
		const pick = head?.pick;
		if (!pick) return { kind: 'blocked', asked: head ? this.#asked.has(head.word) : false };
		if (this.#earlySinceRound >= MATCH_PAIRS_EVERY) {
			this.#earlySinceRound = 0;
			const round = matchRound(items, this.#nextSeed());
			if (round) return { kind: 'round', challenge: round };
		}
		this.#served.add(pick.challenge.id);
		for (const id of pick.challenge.itemIds) this.#asked.delete(id);
		return { kind: 'challenge', ...pick };
	}

	/**
	 * Claims a refill: what it should write for — the next words up to the
	 * mark, sized from the learner's pace, less those already asked for — or
	 * `null` when none of them wants anything. The words it wants are asked for
	 * from here on; the caller starts the task.
	 */
	async refill(): Promise<RefillScope | null> {
		const { pool, items, serving, now, served } = await this.#read();
		const limit = lowWaterMark(median(this.#paces), this.#batchMs);
		const asked = [...this.#asked];
		const wants = planTopUp(pool, items, now, { serving, served, asked, limit });
		if (wants.length === 0) return null;
		for (const want of wants) this.#asked.add(want.item.id);
		return { served, asked, limit };
	}

	/** Forget what was asked for: a retry asks again. */
	resetAsked(): void {
		this.#asked.clear();
	}

	/** An answer was given: its time feeds the pace, its words the round counter. */
	noteAnswered(challenge: Challenge, responseMs: number): void {
		if (!storedDefFor(challenge).reviewsSrs) return;
		if (Number.isFinite(responseMs) && responseMs > 0) {
			this.#paces.push(responseMs);
			if (this.#paces.length > PACE_WINDOW) this.#paces.shift();
		}
		if (isEarlyChallenge(challenge, this.#items)) this.#earlySinceRound++;
	}

	/** A batch came back after `ms`: what the next mark allows for. */
	noteBatch(ms: number): void {
		if (Number.isFinite(ms) && ms > 0) this.#batchMs = ms;
	}

	#nextSeed(): number | undefined {
		if (this.#seed === undefined) return undefined;
		return this.#seed++;
	}
}
