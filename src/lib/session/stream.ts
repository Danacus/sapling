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
 * store for each pick. It makes no write, and it starts no task: refilling is
 * the page's call (a `top-up` task, `$lib/tasks`), made from {@link
 * PracticeStream.outlook} and {@link shouldRefill}, because `$lib/session`
 * never imports `$lib/tasks`.
 */

import { getAllItems, getDifficultyParts, getPool, getProfile } from '$lib/db';
import { storedDefFor } from '$lib/challenges/types';
import type { Challenge, KnowledgeItem, MatchPairsChallenge } from '$lib/types';
import {
	MATCH_PAIRS_EVERY,
	isEarlyChallenge,
	lowWaterMark,
	matchRound,
	nextPick,
	streamOutlook,
	type Outlook,
	type SessionPick
} from './engine';
import { servingFor, type DeviceServing } from './serving';

/** What the stream serves next. */
export type StreamStep =
	| ({ kind: 'challenge' } & SessionPick)
	| { kind: 'round'; challenge: MatchPairsChallenge }
	/** Nothing in the pool fits any word; the outlook says whether writing more would help. */
	| { kind: 'empty'; outlook: StreamOutlook };

/** {@link Outlook} with the mark it is judged against. */
export interface StreamOutlook extends Outlook {
	/** Ready words below which a batch should be written now. */
	lowWater: number;
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

/**
 * Whether the page should start a top-up now: the upcoming words with a pick
 * ready are under the mark (or nothing fits at all), there is something to
 * write, the learner can write (a key, and a connection), and one is not
 * already on its way.
 */
export function shouldRefill(
	outlook: StreamOutlook,
	opts: { canWrite: boolean; writing: boolean }
): boolean {
	return opts.canWrite && !opts.writing && outlook.wants > 0 && outlook.ready < outlook.lowWater;
}

export class PracticeStream {
	readonly #clock: () => number;
	readonly #device: DeviceServing | undefined;
	#seed: number | undefined;
	readonly #served = new Set<string>();
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
	 * The next thing to show: a challenge at its help level, a free match round
	 * when enough early-word challenges have passed and there is a challenge to
	 * follow it, or `empty` when nothing fits.
	 */
	async next(): Promise<StreamStep> {
		const { pool, items, serving, now, served } = await this.#read();
		const pick = nextPick(pool, items, now, { serving, served });
		if (!pick) {
			return {
				kind: 'empty',
				outlook: this.#judge(streamOutlook(pool, items, now, { serving, served }))
			};
		}
		if (this.#earlySinceRound >= MATCH_PAIRS_EVERY) {
			this.#earlySinceRound = 0;
			const round = matchRound(items, this.#nextSeed());
			if (round) return { kind: 'round', challenge: round };
		}
		this.#served.add(pick.challenge.id);
		return { kind: 'challenge', ...pick };
	}

	/** How the upcoming words stand, and the mark refill is judged against. */
	async outlook(): Promise<StreamOutlook> {
		const { pool, items, serving, now, served } = await this.#read();
		return this.#judge(streamOutlook(pool, items, now, { serving, served }));
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

	#judge(outlook: Outlook): StreamOutlook {
		return { ...outlook, lowWater: lowWaterMark(median(this.#paces), this.#batchMs) };
	}

	#nextSeed(): number | undefined {
		if (this.#seed === undefined) return undefined;
		return this.#seed++;
	}
}
