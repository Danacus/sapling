/**
 * The domain-level protocol between the app and its backend.
 *
 * {@link Backend} is the whole surface the window thread may ask of persistence:
 * every method speaks `$lib/types`, none speaks SQL. The Rust core
 * (`crates/sapling-core`, compiled to wasm) implements it beside SQLite —
 * inside the database Worker in the browser, in-process in node tests, both
 * through `host.ts` — and `client.ts` forwards it over `postMessage`. Fixing
 * the boundary here, rather than at the SQL, is what let the implementation
 * change language without the app noticing, and is what would let it change
 * transport (a native shell, a remote host) the same way.
 *
 * Adding a method means adding it to the interface **and** to
 * {@link BACKEND_METHODS} **and** to `dispatch.rs`; leaving one out fails a
 * gate: {@link _everyMethodListed} must stay `never` for `pnpm check`, and
 * `cargo test` reads this file and compares the list to the Rust arms.
 */
import type {
	Challenge,
	ChallengeResult,
	Conversation,
	ConversationExchange,
	KnowledgeItem,
	Profile,
	ReadingText
} from '$lib/types';
import type { ChallengeRow } from './database';
import type { LogRow } from './events';

/**
 * One library row: the conversation, plus the two facts a shelf entry needs
 * that are not on the conversation itself.
 *
 * Both are aggregates of `conversationTurns`, so they are counted in SQL rather
 * than by loading every transcript to measure it — the shelf reads one row per
 * conversation whatever the transcripts weigh.
 */
export interface ConversationSummary extends Conversation {
	/** How many exchanges are stored, opener included. */
	turnCount: number;
	/** When the last one landed; absent while the transcript is still empty. */
	lastTurnAt?: number;
}

/** Envelope version written by {@link Backend.exportData}. */
export const EXPORT_VERSION = 3;

/** Shape of the JSON produced by {@link Backend.exportData}. */
export interface ExportEnvelope {
	version: number;
	exportedAt: number;
	events: LogRow[];
}

/**
 * Everything persistence can be asked to do.
 *
 * ## Every write is an event
 *
 * There is no "write the row, then also append the event" pair to keep in
 * agreement — the event *is* the write, and the read tables are what the
 * materializer makes of the log. Reads never touch `events`.
 *
 * ## Bulk reads are aggregates; the history is per-item
 *
 * `fsrsCard`, `reviewCount`, `correctCount` and `recentGrades` are columns,
 * folded forward one review at a time by the materializer, so {@link getAllItems}
 * costs a single `SELECT` and never scans `reviews`. The rows are still there —
 * they are what lets one item be refolded exactly when a review arrives out of
 * order, and {@link getItem} attaches them for the one word being looked at.
 *
 * ## Items carry their derived schedule
 *
 * Every read that returns items attaches `srs` — due, retrievability, strength —
 * computed by the core against its clock as the row is fetched. The window
 * thread has no FSRS to derive them with, which is the point; the cost is that
 * they are a snapshot, so a view must refetch to see the schedule move.
 *
 * Every argument is plain JSON-shaped data: it crosses `postMessage` in the
 * browser, so there is no place for a function or a `$state` proxy here.
 */
export interface Backend {
	/* ---- Profile ---------------------------------------------------------- */

	/** The stored profile, or `undefined` before onboarding completes. */
	getProfile(): Promise<Profile | undefined>;
	/** Creates or replaces the profile. */
	saveProfile(profile: Profile, now?: number): Promise<void>;

	/* ---- Knowledge items ------------------------------------------------- */

	/**
	 * Every knowledge item the learner has met so far, with an **empty** `history`.
	 *
	 * This is the hot read — most call sites, session start included — so it costs
	 * one `SELECT` over `items` and never touches `reviews`. `recentGrades` is up to
	 * `RECENT_GRADES_CAP` entries (~1 KB) per item and only ever drawn by the words
	 * page's tick strip, so it is left out unless `withRecentGrades` asks for it.
	 * `reviewCount` and `correctCount` are single numbers and always come along.
	 */
	getAllItems(opts?: { withRecentGrades?: boolean }): Promise<KnowledgeItem[]>;
	/** One item, with its whole review history attached. */
	getItem(id: string): Promise<KnowledgeItem | undefined>;
	/**
	 * Inserts or replaces items by `id`.
	 *
	 * An id the table has never seen emits `itemAdded` (full content); a known one
	 * emits `itemUpdated` (the mutable fields only). That distinction is what lets
	 * another device tell "the learner met a new word" from "the learner edited a
	 * note". Card and history on the passed items are deliberately ignored: reviews
	 * arrive through {@link reviewItem} and the card follows from them.
	 */
	upsertItems(items: KnowledgeItem[], now?: number): Promise<void>;
	/**
	 * Forgets one word entirely — the item and its whole review history.
	 *
	 * Safe to call mid-session: pooled challenges keep pointing at the id, and
	 * {@link reviewItem} skips items that are no longer there.
	 */
	deleteItem(id: string, now?: number): Promise<void>;
	/**
	 * Folds a review into an item: appends one history entry.
	 *
	 * A review is `{at, grade}` and nothing else — the caller has no FSRS to
	 * compute a card with, and does not need one. `card` is what the review
	 * folded to, read back after the commit; `prior` is the card as it stood
	 * before it. Both are opaque, and both are `null` when the item is gone.
	 *
	 * With `replaceLast`, the entry supersedes the newest one instead of being
	 * appended — for a review being *recomputed* rather than added (the learner
	 * re-graded the answer they just gave). The rewind is the core's: it refolds
	 * the whole log from the introduction, so nothing has to be handed back to
	 * it. An empty history simply appends.
	 *
	 * `existed` is `false` when the item no longer exists.
	 */
	reviewItem(
		id: string,
		historyEntry: { at: number; grade: number },
		opts?: { replaceLast?: boolean }
	): Promise<{ existed: boolean; prior: unknown; card: unknown }>;

	/* ---- Challenge pool -------------------------------------------------- */

	/**
	 * Adds a freshly generated batch to the pool.
	 *
	 * `generatedAt` is offset by the index so a batch keeps the order it was
	 * written in even when every row lands in the same millisecond — the planner's
	 * "newest first" freshness fill leans on that ordering being total.
	 */
	addToPool(challenges: Challenge[], now?: number, topic?: string): Promise<void>;
	/**
	 * Every challenge the learner could still be shown, in no particular order.
	 *
	 * Reported rows are dropped here rather than at the planner, so "flagged" means
	 * gone everywhere at once. Everything else — eligibility, recycling gaps,
	 * ordering — is `planSession`'s business, working in memory over this array.
	 */
	getPool(): Promise<ChallengeRow[]>;
	/** How many challenges {@link getPool} would return. */
	poolSize(): Promise<number>;
	/**
	 * Stamps a challenge as served: one more play, at `now`.
	 *
	 * Called when an answer is *committed*, not when a challenge is planned, which
	 * is what makes an early quit self-cleaning. A missing id is a no-op: locally
	 * built match-pairs rounds are never pooled.
	 */
	recordServe(id: string, now?: number): Promise<void>;
	/** Flags a challenge as broken. The row stays; {@link getPool} never hands it out again. */
	reportChallenge(id: string, now?: number): Promise<void>;
	/** Looks challenges up by id, reported ones included. Ids that no longer exist are absent. */
	getChallengesByIds(ids: string[]): Promise<Challenge[]>;

	/* ---- Results --------------------------------------------------------- */

	addResult(result: ChallengeResult): Promise<void>;
	/** The most recent results, newest first. */
	recentResults(limit: number): Promise<ChallengeResult[]>;
	/** How many answers landed on each local calendar day, oldest day first. */
	getDailyActivity(): Promise<{ day: string; count: number }[]>;

	/* ---- Reading texts, word marks and lookups --------------------------- */

	/** Stores one reading text, whole. Immutable once written; a deleted id never comes back. */
	addText(text: ReadingText): Promise<void>;
	/** Every stored text, newest first. */
	getTexts(): Promise<ReadingText[]>;
	/** One text by id, or `undefined` when it was deleted (here or on another device). */
	getText(id: string): Promise<ReadingText | undefined>;
	/** Forgets one text. Tombstoned, so a late copy from another device stays gone. */
	deleteText(id: string): Promise<void>;
	/**
	 * Marks a word known, or takes the mark back.
	 *
	 * Not a knowledge item: a marked word is one the learner does not need help
	 * with. Terms are stored trimmed and otherwise verbatim.
	 */
	markWord(term: string, known: boolean): Promise<void>;
	/** The terms currently marked known. */
	getKnownTerms(): Promise<string[]>;
	/**
	 * Records that the learner opened a word's card — "I don't understand this".
	 * Write-only for now; pass `itemId` when the word is tracked.
	 */
	recordLookup(term: string, textId: string, itemId?: string): Promise<void>;

	/* ---- Conversations --------------------------------------------------- */

	/** Opens a conversation: the scene, and nothing else. Immutable once written. */
	addConversation(conversation: Conversation): Promise<void>;
	/**
	 * Appends one exchange — a learner message and the teacher turn that answered
	 * it, or at index 0 the scenario's opener alone. A stored transcript always
	 * ends on a teacher line.
	 */
	addExchange(exchange: ConversationExchange): Promise<void>;
	/** Every conversation, newest first, each with its turn count and last activity. */
	getConversations(): Promise<ConversationSummary[]>;
	/** One conversation and its whole transcript in `idx` order, or `undefined` when deleted. */
	getConversation(
		id: string
	): Promise<{ conversation: Conversation; exchanges: ConversationExchange[] } | undefined>;
	/** Forgets one conversation. Tombstoned. */
	deleteConversation(id: string): Promise<void>;

	/* ---- Export / import ------------------------------------------------- */

	/** Empties the whole database, log included — Settings' "reset my progress". */
	resetData(): Promise<void>;
	/**
	 * Serializes the whole log as JSON, in log order. The log *is* the data, so
	 * the file is complete. Excludes only the API key, which lives in `localStorage`.
	 */
	exportData(): Promise<string>;
	/**
	 * Restores a dump.
	 *
	 * A v3 file is the log itself: its events are unioned in by id and the read
	 * model is rebuilt, so an import is idempotent and order-free. A v1/v2 file
	 * predates the log and replaces the item list wholesale.
	 */
	importData(json: string): Promise<void>;

	/* ---- Sync ------------------------------------------------------------ */

	/**
	 * Up to `limit` events the server has not acknowledged, in log order.
	 *
	 * Exactly the first `limit` unpushed rows, with no gaps — a row this build
	 * cannot read is pushed verbatim like any other, so nothing behind it can
	 * starve behind a page that never empties.
	 */
	pendingEvents(limit: number): Promise<LogRow[]>;
	/** Stamps the `seq` the server assigned each id. Returns how many were stamped. */
	markPushed(seqs: Record<string, number>): Promise<number>;
	/**
	 * Applies a page pulled from the server, in arrival order.
	 *
	 * Rows are raw: one that is not an envelope at all, or carries no `seq`, is
	 * skipped. Returns how many reached the log — this device's own echoes
	 * included, which only stamp their `seq`. A payload this build cannot read
	 * costs its merge rule and nothing else: the row is logged, pushed on and
	 * exported, and a build that knows the kind materialises it.
	 */
	applyRemote(events: unknown[]): Promise<number>;
	/** The pull cursor: the highest `seq` whose page has been applied, `0` before the first. */
	getPullCursor(): Promise<number>;
	setPullCursor(cursor: number): Promise<void>;
}

/**
 * The method names, as a value — the Worker dispatches on it and the client
 * builds its proxy from it.
 */
export const BACKEND_METHODS = [
	'getProfile',
	'saveProfile',
	'getAllItems',
	'getItem',
	'upsertItems',
	'deleteItem',
	'reviewItem',
	'addToPool',
	'getPool',
	'poolSize',
	'recordServe',
	'reportChallenge',
	'getChallengesByIds',
	'addResult',
	'recentResults',
	'getDailyActivity',
	'addText',
	'getTexts',
	'getText',
	'deleteText',
	'markWord',
	'getKnownTerms',
	'recordLookup',
	'addConversation',
	'addExchange',
	'getConversations',
	'getConversation',
	'deleteConversation',
	'resetData',
	'exportData',
	'importData',
	'pendingEvents',
	'markPushed',
	'applyRemote',
	'getPullCursor',
	'setPullCursor'
] as const satisfies readonly (keyof Backend)[];

export type BackendMethod = (typeof BACKEND_METHODS)[number];

/** Fails to compile when a {@link Backend} method is missing from {@link BACKEND_METHODS}. */
type MustBeNever<T extends never> = T;
export type _everyMethodListed = MustBeNever<Exclude<keyof Backend, BackendMethod>>;

export function isBackendMethod(name: string): name is BackendMethod {
	return (BACKEND_METHODS as readonly string[]).includes(name);
}

/**
 * The same interface answering synchronously — what runs beside SQLite, where
 * every statement is blocking anyway and a method is one transaction.
 */
export type Direct<B> = {
	[M in keyof B]: B[M] extends (...args: infer A) => Promise<infer R> ? (...args: A) => R : never;
};

/** Wraps a direct implementation so it satisfies {@link Backend} in-process. */
export function promised(direct: Direct<Backend>): Backend {
	const backend: Partial<Record<BackendMethod, unknown>> = {};
	for (const method of BACKEND_METHODS) {
		const fn = direct[method] as (...args: unknown[]) => unknown;
		backend[method] = async (...args: unknown[]) => fn(...args);
	}
	return backend as Backend;
}

/* -------------------------------------------------------------------------- */
/* Wire format                                                                 */
/* -------------------------------------------------------------------------- */

/** One call, addressed; `args` is typed by the method it names. */
export type BackendRequest = {
	[M in BackendMethod]: { id: number; method: M; args: Parameters<Backend[M]> };
}[BackendMethod];

/**
 * Answers one request. The request's `method` and `args` agree by construction;
 * the cast is because the type system cannot correlate them across the union.
 */
export function dispatch(direct: Direct<Backend>, request: BackendRequest): unknown {
	const fn = direct[request.method] as (...args: unknown[]) => unknown;
	return fn(...request.args);
}

/** What the window sends the Worker: the device it runs on, then calls. */
export type WorkerInbound = { init: { deviceId: string } } | BackendRequest;

/** What comes back: boot outcome once, then one answer per request. */
export type WorkerOutbound =
	| { ready: true }
	| { bootError: string }
	| { id: number; result: unknown }
	| { id: number; error: string };
