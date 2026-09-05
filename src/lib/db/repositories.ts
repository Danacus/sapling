/**
 * Repositories: the only sanctioned way for UI code to touch the database.
 *
 * Signatures speak `$lib/types` only, so the modules that import `$lib/db` do
 * not change when the storage underneath does, which is the whole reason this
 * seam exists.
 *
 * Every function here is one {@link Backend} method, forwarded: the contract is
 * `protocol.ts`, the implementation is `core.ts` beside the database, and this
 * module is what a caller on the window thread holds. A method's optional
 * trailing arguments are applied by the backend, so a call that leaves them out
 * gets the backend's clock, not this thread's.
 */
import { ready } from './backend';
import type { Backend, BackendMethod } from './protocol';

export { challengeOf } from './database';
export { activityByDay, localDay, previousDay, streakFrom } from './day';
export { EXPORT_VERSION, type ConversationSummary, type ExportEnvelope } from './protocol';

function forward<M extends BackendMethod>(method: M): Backend[M] {
	const forwarded = async (...args: unknown[]): Promise<unknown> => {
		const backend = await ready();
		return (backend[method] as (...a: unknown[]) => Promise<unknown>)(...args);
	};
	return forwarded as unknown as Backend[M];
}

export const getProfile = forward('getProfile');
export const saveProfile = forward('saveProfile');

export const getAllItems = forward('getAllItems');
export const getItem = forward('getItem');
export const upsertItems = forward('upsertItems');
export const deleteItem = forward('deleteItem');
const reviewItem = forward('reviewItem');

/**
 * Folds a review into an item — see {@link Backend.reviewItem}.
 *
 * `nextCard` is **not consulted**. It survives in the signature because every
 * caller is written around it and because it documents, at the call site, what
 * the review is supposed to do to the card — but the card the materializer
 * folds is the one source of truth. It is dropped here rather than sent: a
 * function cannot cross to the backend, and the backend has no use for it.
 */
export function updateItemAfterReview(
	id: string,
	_nextCard: (prior: unknown) => unknown,
	historyEntry: { at: number; grade: number },
	opts: { replaceLast?: boolean } = {}
): Promise<{ existed: boolean; prior: unknown }> {
	return reviewItem(id, historyEntry, opts);
}

export const addToPool = forward('addToPool');
export const getPool = forward('getPool');
export const poolSize = forward('poolSize');
export const recordServe = forward('recordServe');
export const reportChallenge = forward('reportChallenge');
export const getChallengesByIds = forward('getChallengesByIds');

export const addResult = forward('addResult');
export const recentResults = forward('recentResults');
export const getDailyActivity = forward('getDailyActivity');

export const addText = forward('addText');
export const getTexts = forward('getTexts');
export const getText = forward('getText');
export const deleteText = forward('deleteText');
export const markWord = forward('markWord');
export const getKnownTerms = forward('getKnownTerms');
export const recordLookup = forward('recordLookup');

export const addConversation = forward('addConversation');
export const addExchange = forward('addExchange');
export const getConversations = forward('getConversations');
export const getConversation = forward('getConversation');
export const deleteConversation = forward('deleteConversation');

export const resetData = forward('resetData');
export const exportData = forward('exportData');
export const importData = forward('importData');
