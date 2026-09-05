/**
 * The backend, implemented: every {@link Backend} method as one synchronous
 * pass over SQLite.
 *
 * This is the code that lives beside the database — inside `sqlite.worker.ts`
 * in the browser, straight over an in-memory database in node tests — and the
 * only place in the app that writes SQL against the read tables. The window
 * thread never sees it; it sees `protocol.ts`.
 *
 * Every write is an event: `commit` mints an envelope and hands it to
 * `materialize.ts`'s `ingest`, so there is no row-then-event pair to keep in
 * agreement. Each method is one transaction, which the synchronous `Sql` makes
 * trivially safe — nothing can interleave with it.
 *
 * `deviceId` arrives from the window at boot. It is a `localStorage` fact, and
 * a Worker has no `localStorage`; reading it here would mint a fresh id per
 * boot, and the id is half of a review's identity.
 *
 * `clock` is the one place the core reads the time — the `at` a local commit is
 * stamped with, the default `now` of a serve or a pool add, an export's
 * `exportedAt`. The app passes nothing and gets `Date.now`; the golden fixtures
 * (`golden.test.ts`) pin it, so every read they record is reproducible.
 */
import { newUuid } from '$lib/device';
import type {
	Challenge,
	ChallengeResult,
	Conversation,
	ConversationExchange,
	ConversationLearnerTurn,
	ConversationScenario,
	ConversationTeacherTurn,
	GlossEntry,
	KnowledgeItem,
	Profile,
	ReadingMedia,
	ReadingSentence,
	ReadingText,
	Verdict
} from '$lib/types';
import type { ChallengeRow } from './database';
import { parseEvent, type EventType, type PayloadFor, type SyncEvent } from './events';
import { LOG_ORDER, ingest, insertOnly, rebuild, type Sql } from './materialize';
import { EXPORT_VERSION, type Backend, type Direct, type ExportEnvelope } from './protocol';
import { DERIVED_TABLES, PROFILE_ID } from './schema';

/** One event to write, before it has an envelope. */
export type Fact = { [T in EventType]: { type: T; payload: PayloadFor<T> } }[EventType];

/** The backend plus the two hooks node tests seed and inspect through. */
export interface Core extends Direct<Backend> {
	/** Appends one local fact and materialises it. */
	commit<T extends EventType>(type: T, payload: PayloadFor<T>): void;
	/** The same, for a run of facts that belong to one action — a single transaction. */
	commitAll(facts: Fact[]): void;
	/** A raw read, for tests that inspect a table the protocol does not expose. */
	query<T>(sql: string, params?: (string | number | null)[]): T[];
}

/** Envelope versions {@link Backend.importData} still restores from. */
const LEGACY_IMPORT_VERSIONS = [1, 2];

const PULL_CURSOR_KEY = 'pullCursor';

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                  */
/* -------------------------------------------------------------------------- */

interface ReviewRow {
	itemId: string;
	at: number;
	grade: number;
	device: string;
}

interface ItemRow {
	id: string;
	kind: string;
	term: string;
	meaning: string;
	romanization: string | null;
	notes: string | null;
	introducedAt: number;
	fsrsCard: string;
	reviewCount: number;
	correctCount: number;
	/** Absent when the query left the column out — `getAllItems`'s lean default. */
	recentGrades?: string;
}

interface ChallengeSqlRow {
	id: string;
	content: string;
	generatedAt: number;
	topic: string | null;
	reported: number;
	timesServed: number;
	lastServedAt: number | null;
}

interface ResultSqlRow {
	challengeId: string;
	verdict: string;
	answerGiven: string;
	at: number;
}

interface ProfileSqlRow {
	nativeLanguage: string;
	targetLanguage: string;
	level: string;
	interests: string;
	about: string | null;
	model: string;
	createdAt: number;
}

interface TextSqlRow {
	id: string;
	title: string;
	source: string;
	topic: string | null;
	sentences: string;
	glossary: string;
	media: string | null;
	createdAt: number;
}

interface ConversationSqlRow {
	id: string;
	scenario: string;
	topic: string | null;
	createdAt: number;
}

interface ConversationTurnSqlRow {
	idx: number;
	learner: string | null;
	teacher: string;
}

interface EventSqlRow {
	id: string;
	type: string;
	at: number;
	device: string;
	payload: string;
}

/** Columns `getAllItems` reads by default — everything but `recentGrades`. */
const ITEM_COLUMNS_LEAN =
	'id, kind, term, meaning, romanization, notes, introducedAt, fsrsCard, reviewCount, correctCount';

/* -------------------------------------------------------------------------- */
/* Row assembly                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reassembles the `KnowledgeItem` the rest of the app expects.
 *
 * SQLite has no "absent", so a nullable column comes back as `null` where the
 * domain type means "not set at all". Converting back here keeps `romanization`
 * genuinely optional for the Latin-script languages that never have one.
 */
function itemFrom(row: ItemRow, history: readonly ReviewRow[]): KnowledgeItem {
	return {
		id: row.id,
		kind: row.kind as KnowledgeItem['kind'],
		term: row.term,
		meaning: row.meaning,
		...(row.romanization === null ? {} : { romanization: row.romanization }),
		...(row.notes === null ? {} : { notes: row.notes }),
		introducedAt: row.introducedAt,
		fsrsCard: JSON.parse(row.fsrsCard) as unknown,
		reviewCount: row.reviewCount,
		correctCount: row.correctCount,
		...(row.recentGrades === undefined
			? {}
			: { recentGrades: JSON.parse(row.recentGrades) as { at: number; grade: number }[] }),
		history: history.map(({ at, grade, device }) => ({ at, grade, device }))
	};
}

function challengeRowFrom(row: ChallengeSqlRow): ChallengeRow {
	return {
		...(JSON.parse(row.content) as Challenge),
		generatedAt: row.generatedAt,
		timesServed: row.timesServed,
		lastServedAt: row.lastServedAt,
		reported: row.reported === 1,
		...(row.topic === null ? {} : { topic: row.topic })
	};
}

function resultFrom(row: ResultSqlRow): ChallengeResult {
	return {
		challengeId: row.challengeId,
		verdict: row.verdict as Verdict,
		answerGiven: row.answerGiven,
		at: row.at
	};
}

function textFrom(row: TextSqlRow): ReadingText {
	return {
		id: row.id,
		title: row.title,
		source: row.source as ReadingText['source'],
		...(row.topic === null ? {} : { topic: row.topic }),
		sentences: JSON.parse(row.sentences) as ReadingSentence[],
		glossary: JSON.parse(row.glossary) as GlossEntry[],
		...(row.media === null ? {} : { media: JSON.parse(row.media) as ReadingMedia }),
		createdAt: row.createdAt
	};
}

function conversationFrom(row: ConversationSqlRow): Conversation {
	return {
		id: row.id,
		scenario: JSON.parse(row.scenario) as ConversationScenario,
		...(row.topic === null ? {} : { topic: row.topic }),
		createdAt: row.createdAt
	};
}

function eventFrom(row: EventSqlRow): SyncEvent {
	return {
		id: row.id,
		type: row.type as EventType,
		at: row.at,
		device: row.device,
		payload: JSON.parse(row.payload) as unknown
	};
}

function itemAddedFact(item: KnowledgeItem): Fact {
	return {
		type: 'itemAdded',
		payload: {
			id: item.id,
			kind: item.kind,
			term: item.term,
			meaning: item.meaning,
			...(item.romanization === undefined ? {} : { romanization: item.romanization }),
			...(item.notes === undefined ? {} : { notes: item.notes }),
			introducedAt: item.introducedAt
		}
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** A usable `seq` off a row, even one too malformed to parse as an event. */
function seqOf(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	const seq = raw.seq;
	return typeof seq === 'number' && Number.isInteger(seq) && seq > 0 ? seq : undefined;
}

/* -------------------------------------------------------------------------- */
/* The core                                                                    */
/* -------------------------------------------------------------------------- */

/** Builds the backend over an open, schema-applied database. */
export function makeCore(sql: Sql, deviceId: string, clock: () => number = Date.now): Core {
	/** Runs `body` in one transaction; a throw rolls the whole thing back. */
	function transaction<T>(body: () => T): T {
		sql.exec('BEGIN');
		try {
			const result = body();
			sql.exec('COMMIT');
			return result;
		} catch (error) {
			sql.exec('ROLLBACK');
			throw error;
		}
	}

	function commitAll(facts: Fact[]): void {
		if (facts.length === 0) return;
		const at = clock();
		transaction(() => {
			for (const fact of facts) {
				ingest(
					sql,
					{ id: newUuid(), type: fact.type, at, device: deviceId, payload: fact.payload },
					null
				);
			}
		});
	}

	function commit<T extends EventType>(type: T, payload: PayloadFor<T>): void {
		commitAll([{ type, payload } as Fact]);
	}

	function saveProfile(profile: Profile): void {
		commit('profileUpdated', {
			nativeLanguage: profile.nativeLanguage,
			targetLanguage: profile.targetLanguage,
			level: profile.level,
			interests: profile.interests,
			...(profile.about === undefined ? {} : { about: profile.about }),
			model: profile.model,
			createdAt: profile.createdAt
		});
	}

	/** v1/v2: replaces the item list wholesale, as those envelopes meant. */
	function importLegacy(parsed: Record<string, unknown>): void {
		if (!Array.isArray(parsed.items)) throw new Error('Import failed: missing item list.');
		if (parsed.profile !== null && !isRecord(parsed.profile)) {
			throw new Error('Import failed: malformed profile.');
		}
		const items = parsed.items as KnowledgeItem[];
		const profile = parsed.profile as Profile | null;
		const facts: Fact[] = [];

		for (const row of sql.query<{ id: string }>('SELECT id FROM items')) {
			facts.push({ type: 'itemDeleted', payload: { itemId: row.id } });
		}
		for (const item of items) {
			facts.push(itemAddedFact(item));
			for (const entry of item.history ?? []) {
				facts.push({
					type: 'itemReviewed',
					payload: {
						device: entry.device ?? deviceId,
						at: entry.at,
						itemId: item.id,
						grade: entry.grade
					}
				});
			}
		}

		commitAll(facts);
		if (profile) saveProfile(profile);
	}

	return {
		commit,
		commitAll,
		query: (statement, params) => sql.query(statement, params),

		/* ---- Profile ------------------------------------------------------ */

		getProfile() {
			const row = sql.query<ProfileSqlRow>('SELECT * FROM profile WHERE id = ?', [PROFILE_ID])[0];
			if (!row) return undefined;
			return {
				nativeLanguage: row.nativeLanguage,
				targetLanguage: row.targetLanguage,
				level: row.level as Profile['level'],
				interests: JSON.parse(row.interests) as string[],
				...(row.about === null ? {} : { about: row.about }),
				model: row.model,
				createdAt: row.createdAt
			};
		},

		saveProfile(profile) {
			saveProfile(profile);
		},

		/* ---- Knowledge items --------------------------------------------- */

		getAllItems(opts = {}) {
			const columns = opts.withRecentGrades ? '*' : ITEM_COLUMNS_LEAN;
			return sql.query<ItemRow>(`SELECT ${columns} FROM items`).map((row) => itemFrom(row, []));
		},

		getItem(id) {
			const row = sql.query<ItemRow>('SELECT * FROM items WHERE id = ?', [id])[0];
			if (!row) return undefined;
			const history = sql.query<ReviewRow>(
				'SELECT itemId, at, grade, device FROM reviews WHERE itemId = ? ORDER BY at, device',
				[id]
			);
			return itemFrom(row, history);
		},

		upsertItems(items) {
			if (items.length === 0) return;
			const placeholders = items.map(() => '?').join(', ');
			const known = new Set(
				sql
					.query<{ id: string }>(
						`SELECT id FROM items WHERE id IN (${placeholders})`,
						items.map((item) => item.id)
					)
					.map((r) => r.id)
			);
			commitAll(
				items.map((item): Fact =>
					known.has(item.id)
						? {
								type: 'itemUpdated',
								payload: {
									itemId: item.id,
									fields: {
										term: item.term,
										meaning: item.meaning,
										...(item.romanization === undefined ? {} : { romanization: item.romanization }),
										...(item.notes === undefined ? {} : { notes: item.notes })
									}
								}
							}
						: itemAddedFact(item)
				)
			);
		},

		deleteItem(id) {
			commit('itemDeleted', { itemId: id });
		},

		reviewItem(id, historyEntry, opts = {}) {
			const row = sql.query<{ fsrsCard: string }>('SELECT fsrsCard FROM items WHERE id = ?', [
				id
			])[0];
			if (!row) return { existed: false, prior: null };

			const prior = JSON.parse(row.fsrsCard) as unknown;
			const { at, grade } = historyEntry;

			const replaced = opts.replaceLast
				? sql.query<{ at: number }>(
						'SELECT at FROM reviews WHERE itemId = ? ORDER BY at DESC, device DESC LIMIT 1',
						[id]
					)[0]
				: undefined;

			if (replaced) {
				commit('reviewAmended', {
					device: deviceId,
					at,
					itemId: id,
					grade,
					replaces: replaced.at
				});
			} else {
				commit('itemReviewed', { device: deviceId, at, itemId: id, grade });
			}
			return { existed: true, prior };
		},

		/* ---- Challenge pool ---------------------------------------------- */

		addToPool(challenges, now = clock(), topic) {
			if (challenges.length === 0) return;
			const trimmed = topic?.trim();
			commitAll(
				challenges.map((challenge, index): Fact => ({
					type: 'challengeAdded',
					payload: {
						challenge,
						generatedAt: now + index,
						...(trimmed ? { topic: trimmed } : {})
					}
				}))
			);
		},

		getPool() {
			return sql
				.query<ChallengeSqlRow>('SELECT * FROM challenges WHERE reported = 0')
				.map(challengeRowFrom);
		},

		poolSize() {
			const row = sql.query<{ count: number }>(
				'SELECT count(*) AS count FROM challenges WHERE reported = 0'
			)[0];
			return row?.count ?? 0;
		},

		recordServe(id, now = clock()) {
			const known = sql.query('SELECT 1 FROM challenges WHERE id = ?', [id]);
			if (known.length === 0) return;
			commit('challengeServed', { challengeId: id, at: now });
		},

		reportChallenge(id) {
			commit('challengeReported', { challengeId: id });
		},

		getChallengesByIds(ids) {
			if (ids.length === 0) return [];
			const placeholders = ids.map(() => '?').join(', ');
			return sql
				.query<{ content: string }>(
					`SELECT content FROM challenges WHERE id IN (${placeholders})`,
					ids
				)
				.map((row) => JSON.parse(row.content) as Challenge);
		},

		/* ---- Results ----------------------------------------------------- */

		addResult(result) {
			commit('resultLogged', {
				challengeId: result.challengeId,
				verdict: result.verdict,
				answerGiven: result.answerGiven,
				at: result.at
			});
		},

		recentResults(limit) {
			if (limit <= 0) return [];
			return sql
				.query<ResultSqlRow>('SELECT * FROM results ORDER BY at DESC LIMIT ?', [limit])
				.map(resultFrom);
		},

		getDailyActivity() {
			return sql.query<{ day: string; count: number }>(
				'SELECT day, count FROM daily ORDER BY day ASC'
			);
		},

		/* ---- Reading texts, word marks and lookups ----------------------- */

		addText(text) {
			commit('textAdded', {
				id: text.id,
				title: text.title,
				source: text.source,
				...(text.topic === undefined ? {} : { topic: text.topic }),
				sentences: text.sentences,
				glossary: text.glossary,
				...(text.media === undefined ? {} : { media: text.media }),
				createdAt: text.createdAt
			});
		},

		getTexts() {
			return sql.query<TextSqlRow>('SELECT * FROM texts ORDER BY createdAt DESC').map(textFrom);
		},

		getText(id) {
			const row = sql.query<TextSqlRow>('SELECT * FROM texts WHERE id = ?', [id])[0];
			return row === undefined ? undefined : textFrom(row);
		},

		deleteText(id) {
			commit('textDeleted', { textId: id });
		},

		markWord(term, known) {
			const trimmed = term.trim();
			if (trimmed === '') return;
			commit('wordMarked', { term: trimmed, known });
		},

		getKnownTerms() {
			return sql
				.query<{ term: string }>('SELECT term FROM wordMarks WHERE known = 1')
				.map((row) => row.term);
		},

		recordLookup(term, textId, itemId) {
			const trimmed = term.trim();
			if (trimmed === '') return;
			commit('wordLookedUp', {
				term: trimmed,
				...(itemId === undefined ? {} : { itemId }),
				textId
			});
		},

		/* ---- Conversations ----------------------------------------------- */

		addConversation(conversation) {
			commit('conversationStarted', {
				id: conversation.id,
				scenario: conversation.scenario,
				...(conversation.topic === undefined ? {} : { topic: conversation.topic }),
				createdAt: conversation.createdAt
			});
		},

		addExchange(exchange) {
			commit('turnAdded', {
				conversationId: exchange.conversationId,
				index: exchange.index,
				...(exchange.learner === undefined ? {} : { learner: exchange.learner }),
				teacher: exchange.teacher
			});
		},

		getConversations() {
			const rows = sql.query<ConversationSqlRow & { turnCount: number; lastTurnAt: number | null }>(
				`SELECT c.id, c.scenario, c.topic, c.createdAt,
				        count(t.idx) AS turnCount, max(t.at) AS lastTurnAt
				 FROM conversations c
				 LEFT JOIN conversationTurns t ON t.conversationId = c.id
				 GROUP BY c.id
				 ORDER BY c.createdAt DESC`
			);
			return rows.map((row) => ({
				...conversationFrom(row),
				turnCount: row.turnCount,
				...(row.lastTurnAt === null ? {} : { lastTurnAt: row.lastTurnAt })
			}));
		},

		getConversation(id) {
			const row = sql.query<ConversationSqlRow>('SELECT * FROM conversations WHERE id = ?', [
				id
			])[0];
			if (row === undefined) return undefined;
			// Read by id rather than joined, so a turn that outran its
			// `conversationStarted` across a sync is still picked up once the scene lands.
			const turns = sql.query<ConversationTurnSqlRow>(
				'SELECT idx, learner, teacher FROM conversationTurns WHERE conversationId = ? ORDER BY idx',
				[id]
			);
			return {
				conversation: conversationFrom(row),
				exchanges: turns.map((turn) => ({
					conversationId: id,
					index: turn.idx,
					...(turn.learner === null
						? {}
						: { learner: JSON.parse(turn.learner) as ConversationLearnerTurn }),
					teacher: JSON.parse(turn.teacher) as ConversationTeacherTurn
				}))
			};
		},

		deleteConversation(id) {
			commit('conversationDeleted', { conversationId: id });
		},

		/* ---- Export / import --------------------------------------------- */

		resetData() {
			transaction(() => {
				for (const table of [...DERIVED_TABLES, 'events', 'meta']) sql.exec(`DELETE FROM ${table}`);
			});
		},

		exportData() {
			const rows = sql.query<EventSqlRow>(
				`SELECT id, type, at, device, payload FROM events ORDER BY ${LOG_ORDER}`
			);
			const envelope: ExportEnvelope = {
				version: EXPORT_VERSION,
				exportedAt: clock(),
				events: rows.map(eventFrom)
			};
			return JSON.stringify(envelope, null, 2);
		},

		importData(json) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(json);
			} catch {
				throw new Error('Import failed: the file is not valid JSON.');
			}
			if (!isRecord(parsed)) throw new Error('Import failed: unexpected file contents.');

			if (parsed.version === EXPORT_VERSION) {
				if (!Array.isArray(parsed.events)) throw new Error('Import failed: missing event list.');
				const events = parsed.events
					.map((raw) => parseEvent(raw))
					.filter((event): event is SyncEvent => event !== undefined);
				transaction(() => {
					for (const event of events) insertOnly(sql, event);
					rebuild(sql);
				});
				return;
			}

			// A v1 envelope still restores: it carries a `stats` field that no longer
			// means anything, and everything else is unchanged, so it is simply ignored.
			if (typeof parsed.version !== 'number' || !LEGACY_IMPORT_VERSIONS.includes(parsed.version)) {
				throw new Error(`Import failed: unsupported export version ${String(parsed.version)}.`);
			}
			importLegacy(parsed);
		},

		/* ---- Sync -------------------------------------------------------- */

		pendingEvents(limit) {
			return sql
				.query<EventSqlRow>(
					`SELECT id, type, at, device, payload FROM events
					 WHERE seq IS NULL ORDER BY ${LOG_ORDER} LIMIT ?`,
					[limit]
				)
				.map(eventFrom);
		},

		markPushed(seqs) {
			const entries = Object.entries(seqs);
			transaction(() => {
				for (const [id, seq] of entries) {
					sql.exec('UPDATE events SET seq = ? WHERE id = ?', [seq, id]);
				}
			});
			return entries.length;
		},

		applyRemote(events) {
			let applied = 0;
			transaction(() => {
				for (const raw of events) {
					const seq = seqOf(raw);
					const event = parseEvent(raw);
					if (seq === undefined || event === undefined) continue;
					ingest(sql, event, seq);
					applied++;
				}
			});
			return applied;
		},

		getPullCursor() {
			const row = sql.query<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
				PULL_CURSOR_KEY
			])[0];
			const parsed = row ? Number.parseInt(row.value, 10) : 0;
			return Number.isFinite(parsed) ? parsed : 0;
		},

		setPullCursor(cursor) {
			sql.exec(
				`INSERT INTO meta (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				[PULL_CURSOR_KEY, String(cursor)]
			);
		}
	};
}
