/**
 * Small, dependency-free `localStorage` preferences for the UI layer.
 *
 * Deliberately separate from `$lib/db/settings` (device secrets and the
 * chosen model) — these are display preferences with no bearing on what gets
 * sent anywhere, so they live next to the components that read them. Every
 * accessor is guarded so the module is safe to import from a non-browser
 * context (SSR-less here, but tests still run in node).
 */

const ROMANIZATION_MODE_KEY = 'll.romanizationMode';
/** Superseded by {@link ROMANIZATION_MODE_KEY}; still read once, to migrate. */
const SHOW_ROMANIZATION_KEY = 'll.showRomanization';
const LISTENING_MODE_KEY = 'll.listeningMode';
const RECENT_TOPICS_KEY = 'll.recentTopics';
const REVIEW_ONLY_KEY = 'll.reviewOnlyMode';

/** At most this many recent topics are remembered. */
export const MAX_RECENT_TOPICS = 5;

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

/**
 * How romanization (pinyin, romaji, ...) renders under target-script text.
 *
 * `'adaptive'` is the interesting one: the reading is a crutch, and a crutch
 * that never goes away is a crutch the learner keeps leaning on. Under it the
 * decision is made per served challenge from how well its words are known —
 * see `$lib/session/romanization`.
 */
export type RomanizationMode = 'off' | 'on' | 'adaptive';

const ROMANIZATION_MODES: readonly RomanizationMode[] = ['off', 'on', 'adaptive'];

/**
 * The learner's romanization mode. Defaults to `'on'` when the setting has
 * never been touched.
 *
 * Falls back to the legacy boolean key when the mode key is absent or holds
 * something unrecognized, so a learner who had turned readings off stays off
 * across the upgrade rather than having them silently reappear.
 */
export function getRomanizationMode(): RomanizationMode {
	if (!hasStorage()) return 'on';
	try {
		const raw = localStorage.getItem(ROMANIZATION_MODE_KEY);
		if (raw !== null && (ROMANIZATION_MODES as readonly string[]).includes(raw)) {
			return raw as RomanizationMode;
		}
		return localStorage.getItem(SHOW_ROMANIZATION_KEY) === '0' ? 'off' : 'on';
	} catch {
		return 'on';
	}
}

/** Persists the romanization mode. Writes the new key only. */
export function setRomanizationMode(mode: RomanizationMode): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(ROMANIZATION_MODE_KEY, mode);
	} catch {
		/* ignore: storage unavailable */
	}
}

/**
 * Whether some recognize-style challenges may be presented audio-first, with
 * the prompt spoken and its text hidden until the learner asks for it (see
 * `isListeningChallenge` in `$lib/session/engine`).
 *
 * On by default — it is the cheapest listening practice the app has, and it is
 * always one tap away from turning back into an ordinary reading challenge.
 * Off is for learners who cannot use audio at all, or do not want to.
 */
export function getListeningMode(): boolean {
	if (!hasStorage()) return true;
	try {
		const raw = localStorage.getItem(LISTENING_MODE_KEY);
		return raw === null ? true : raw === '1';
	} catch {
		return true;
	}
}

/** Persists the listening-mode toggle. */
export function setListeningMode(on: boolean): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(LISTENING_MODE_KEY, on ? '1' : '0');
	} catch {
		/* ignore: storage unavailable */
	}
}

/**
 * Whether the learner has declined new vocabulary: sessions are built only
 * from words they have already been reviewed on at least once, and a lesson
 * generated while it's on clamps its new-word slots to zero — fresh
 * challenges, nothing new to learn (see `$lib/session/engine`'s `reviewOnly`
 * options on both the session and the generation side).
 *
 * Off by default, unlike listening mode: this is a deliberate restriction the
 * learner opts into (e.g. "just let me review, don't teach me anything new
 * today"), not a convenience that should apply until they notice and turn it
 * off.
 */
export function getReviewOnlyMode(): boolean {
	if (!hasStorage()) return false;
	try {
		const raw = localStorage.getItem(REVIEW_ONLY_KEY);
		return raw === '1';
	} catch {
		return false;
	}
}

/** Persists the review-only toggle. */
export function setReviewOnlyMode(on: boolean): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(REVIEW_ONLY_KEY, on ? '1' : '0');
	} catch {
		/* ignore: storage unavailable */
	}
}

/**
 * Most-recent-first list of free-form lesson topics the learner has typed.
 *
 * The only topic memory there is. A "current topic" used to be persisted too,
 * so a half-played queue could say what it was resuming — the pool model has no
 * such thing to resume, and a topic belongs to the batch that was generated
 * with it (stored on the row), not to a session.
 */
export function getRecentTopics(): string[] {
	if (!hasStorage()) return [];
	try {
		const raw = localStorage.getItem(RECENT_TOPICS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((entry): entry is string => typeof entry === 'string');
	} catch {
		return [];
	}
}

/**
 * Records a topic as the most recent one, de-duplicating case/whitespace-
 * insensitively and capping the list at {@link MAX_RECENT_TOPICS}. Blank input
 * is a no-op. Returns the updated list.
 */
export function addRecentTopic(topic: string): string[] {
	const trimmed = topic.trim();
	if (!trimmed) return getRecentTopics();

	const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
	const rest = getRecentTopics().filter(
		(existing) => existing.trim().toLowerCase().replace(/\s+/g, ' ') !== key
	);
	const updated = [trimmed, ...rest].slice(0, MAX_RECENT_TOPICS);

	if (hasStorage()) {
		try {
			localStorage.setItem(RECENT_TOPICS_KEY, JSON.stringify(updated));
		} catch {
			/* ignore: storage unavailable or full */
		}
	}

	return updated;
}
