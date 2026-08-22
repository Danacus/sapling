/**
 * Batch generation: turn the learner's profile plus their due/new items into a
 * playable set of challenges.
 */

import type { Challenge, KnowledgeItem, Profile } from '$lib/types';

export interface GenerateBatchOptions {
	profile: Profile;
	/** Items scheduled for review by the SRS. */
	dueItems: KnowledgeItem[];
	/** How many brand-new items the batch may introduce. */
	newItemCount: number;
	/** Target number of challenges in the batch. */
	challengeCount: number;
	signal?: AbortSignal;
}

export interface GeneratedBatch {
	/** Newly introduced items, with fresh FSRS cards. */
	newItems: KnowledgeItem[];
	challenges: Challenge[];
}

/** Builds the system prompt from the profile. TODO. */
export function buildSystemPrompt(_profile: Profile): string {
	throw new Error('TODO: buildSystemPrompt');
}

/** Builds the user prompt listing due items and the requested batch shape. TODO. */
export function buildUserPrompt(_options: GenerateBatchOptions): string {
	throw new Error('TODO: buildUserPrompt');
}

/** Generates, validates and normalizes one batch. TODO. */
export async function generateBatch(_options: GenerateBatchOptions): Promise<GeneratedBatch> {
	throw new Error('TODO: generateBatch');
}
