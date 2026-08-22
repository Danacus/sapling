/**
 * Small, dependency-free `localStorage` preferences for the UI layer.
 *
 * Deliberately separate from `$lib/db/settings` (device secrets and the
 * chosen model) — these are display preferences with no bearing on what gets
 * sent anywhere, so they live next to the components that read them. Every
 * accessor is guarded so the module is safe to import from a non-browser
 * context (SSR-less here, but tests still run in node).
 */

const SHOW_ROMANIZATION_KEY = 'll.showRomanization';
const RECENT_TOPICS_KEY = 'll.recentTopics';
const CURRENT_TOPIC_KEY = 'll.currentTopic';

/** At most this many recent topics are remembered. */
export const MAX_RECENT_TOPICS = 5;

function hasStorage(): boolean {
	return typeof localStorage !== 'undefined';
}

/**
 * Whether romanization (pinyin, romaji, ...) should render under target-script
 * text. Defaults to shown when the learner has never touched the setting.
 */
export function getShowRomanization(): boolean {
	if (!hasStorage()) return true;
	try {
		const raw = localStorage.getItem(SHOW_ROMANIZATION_KEY);
		return raw === null ? true : raw === '1';
	} catch {
		return true;
	}
}

/** Persists the romanization toggle. */
export function setShowRomanization(show: boolean): void {
	if (!hasStorage()) return;
	try {
		localStorage.setItem(SHOW_ROMANIZATION_KEY, show ? '1' : '0');
	} catch {
		/* ignore: storage unavailable */
	}
}

/** Most-recent-first list of free-form session topics the learner has typed. */
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
	const rest = getRecentTopics().filter((existing) => existing.trim().toLowerCase().replace(/\s+/g, ' ') !== key);
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

/**
 * The topic the *currently queued* challenges were generated for, so a
 * resumed session can say what it is resuming. `undefined` means either no
 * topic was given (a "just review" session) or the queue has since been
 * cleared.
 */
export function getCurrentTopic(): string | undefined {
	if (!hasStorage()) return undefined;
	try {
		return localStorage.getItem(CURRENT_TOPIC_KEY) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Records the topic a freshly booted session used, or clears it (pass
 * `undefined`/blank) for a topicless session or once the queue it described
 * has been cleared.
 */
export function setCurrentTopic(topic: string | undefined): void {
	if (!hasStorage()) return;
	const trimmed = topic?.trim();
	try {
		if (trimmed) localStorage.setItem(CURRENT_TOPIC_KEY, trimmed);
		else localStorage.removeItem(CURRENT_TOPIC_KEY);
	} catch {
		/* ignore: storage unavailable */
	}
}
