/**
 * The stored shape of a pooled challenge: the domain `Challenge` union plus
 * the pool bookkeeping the stream and the difficulty model read, and the one
 * function that sheds that bookkeeping again.
 */

import type { Challenge, PoolRow } from './generated/index';

/**
 * Stored challenge: the domain `Challenge` union plus pool bookkeeping —
 * `generatedAt`, `timesServed`, `lastServedAt` (`null` while never served),
 * `reported` and `topic?`. Generated from `sapling-challenges`' `PoolRow`, an
 * intersection, so the `type` discriminant still narrows after a read.
 *
 * Every challenge ever generated stays in the pool — answering one does not
 * consume it, it only stamps it — and the stream decides what is worth
 * playing again from these fields.
 */
export type ChallengeRow = PoolRow;

/** The fields a pool row has that no `Challenge` has: the bookkeeping. */
type Bookkeeping = Exclude<keyof PoolRow, keyof Challenge>;

/**
 * Every bookkeeping field, as a value `challengeOf` can strip by.
 *
 * The list has to equal {@link Bookkeeping} exactly, and the compiler holds it
 * to that: `satisfies` refuses a name `PoolRow` does not have, and `exhaustive`
 * below refuses a `PoolRow` field the list forgot, which would otherwise leak
 * into every served `Challenge`.
 */
const BOOKKEEPING = [
	'generatedAt',
	'timesServed',
	'lastServedAt',
	'reported',
	'topic'
] as const satisfies readonly Bookkeeping[];

type Unstripped = Exclude<Bookkeeping, (typeof BOOKKEEPING)[number]>;
/** A type error here names the `PoolRow` field `BOOKKEEPING` is missing. */
const exhaustive: [Unstripped] extends [never] ? true : Unstripped = true;
void exhaustive;

/**
 * Sheds the bookkeeping above, leaving the immutable domain `Challenge`.
 *
 * The cast is unavoidable: removing keys from a discriminated union produces a
 * type that no longer narrows on `type`, even though every field of it survived.
 */
export function challengeOf(row: ChallengeRow): Challenge {
	const challenge: Record<string, unknown> = { ...row };
	for (const key of BOOKKEEPING) delete challenge[key];
	return challenge as unknown as Challenge;
}
