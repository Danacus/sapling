/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Keep Dexie types out of the signatures here so callers depend on
 * `$lib/types` only. Every function is a TODO stub.
 */

import type { ChallengeResult, KnowledgeItem, Profile, Stats } from '$lib/types';

/* -------------------------------------------------------------------------- */
/* Profile                                                                    */
/* -------------------------------------------------------------------------- */

/** Returns the stored profile, or `undefined` before onboarding completes. */
export async function getProfile(): Promise<Profile | undefined> {
	throw new Error('TODO: getProfile');
}

/** Creates or replaces the profile. */
export async function saveProfile(_profile: Profile): Promise<void> {
	throw new Error('TODO: saveProfile');
}

/* -------------------------------------------------------------------------- */
/* Knowledge items                                                            */
/* -------------------------------------------------------------------------- */

export async function getItem(_id: string): Promise<KnowledgeItem | undefined> {
	throw new Error('TODO: getItem');
}

export async function listItems(): Promise<KnowledgeItem[]> {
	throw new Error('TODO: listItems');
}

/** Items whose FSRS due date is at or before `at` (epoch ms), oldest first. */
export async function listDueItems(_at: number, _limit?: number): Promise<KnowledgeItem[]> {
	throw new Error('TODO: listDueItems');
}

export async function upsertItems(_items: KnowledgeItem[]): Promise<void> {
	throw new Error('TODO: upsertItems');
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export async function recordResult(_result: ChallengeResult): Promise<void> {
	throw new Error('TODO: recordResult');
}

export async function listResults(_since?: number): Promise<ChallengeResult[]> {
	throw new Error('TODO: listResults');
}

/* -------------------------------------------------------------------------- */
/* Stats                                                                      */
/* -------------------------------------------------------------------------- */

export async function getStats(): Promise<Stats> {
	throw new Error('TODO: getStats');
}

/** Adds XP for the given local day and rolls the streak forward. */
export async function addXp(_day: string, _xp: number): Promise<Stats> {
	throw new Error('TODO: addXp');
}

/** Wipes all local data (settings screen "reset progress"). */
export async function resetAll(): Promise<void> {
	throw new Error('TODO: resetAll');
}
