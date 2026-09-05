/**
 * Mock mode: a full lesson batch with no API key and no network.
 *
 * The fixtures are deterministic and go through the *same* parse/resolve path
 * as a real completion — they are written in the generation wire format, emitted
 * as a fenced JSON string and fed to `parseBatch` + `resolveBatch` — so
 * developing against the mock exercises the real code, not a parallel happy
 * path. Option order, blank placement and the derived accepted answers are all
 * produced by the resolver here exactly as they are for a paid batch.
 *
 * Two fixture sets, chosen by the profile's target language, each a small
 * restaurant scene so the mock shows off what a topic-driven batch looks like:
 *
 * - **Spanish for English speakers** (the default): every wire type —
 *   recognize-mc, produce-mc, cloze with and without distractorWords,
 *   translate-to-target, translate-to-native, word-order and spot-error — with
 *   `"reading": null` throughout, as a Latin-script lesson has.
 * - **Mandarin for English speakers**, selected when the target language names
 *   Chinese: the same coverage with pinyin on every target-script string, so
 *   the romanization UI can be built and eyeballed with no API key. Set the
 *   target language to "Chinese" in onboarding to get it.
 *
 * The canned challenges themselves are **not** written here: each wire type
 * carries its own examples for both scenarios in `./challenge-types/<type>.ts`,
 * beside the schema they have to satisfy, and this module folds them back into
 * one lesson by their `order`. That is what makes coverage automatic — a type
 * with no fixture is a type with no example, and `registry.test.ts` says so —
 * and it is why each scenario's own two-word vocabulary, which belongs to the
 * scene rather than to any one challenge, is the only fixture data left below.
 *
 * The mock ignores the wants' kinds and rungs, deliberately. Its job is to show
 * every wire type and every romanization case at once so the UI can be built
 * against them; a mock that honoured the wants would serve whichever handful
 * of types they happened to name and would stop being a fixture. That is also
 * why it hands `parseBatch` the *union* schema rather than one type's member —
 * the paid path validates each reply against the one type that request asked
 * for. It stays *one* assembly rather than a fan-out — nothing is being timed
 * or rate-limited here — so `mockBatch` is synchronous and byte-identical
 * across runs.
 *
 * That vocabulary is **borrowed, never introduced**: generation adds no words
 * to a collection, so the mock cannot either. Each scenario word is bound to
 * one of the words the wants are about before resolving — see
 * {@link mockTermIndex} — which keeps the canned lesson readable as the scene
 * it was written as while every id it ends up citing is one the caller really
 * asked about.
 */

import { getApiKey } from '$lib/db/settings';
import { bcp47For } from '$lib/tts/languages';
import { WIRE_TYPE_DEFS } from './challenge-types';
import type { FixtureScenario } from './challenge-types';
import type { TokenUsage } from './client';
import type { BatchArgs, BatchOptions, BatchResult } from './generate';
import { knownTermIndex, parseBatch, resolveBatch } from './generate';
import type { WantItem } from './requests';
import type { EscalationArgs, EscalationResult } from './escalation';

/** localStorage flag that forces the mock even when a key is present. */
export const MOCK_FLAG_KEY = 'll.mockMode';

/**
 * True when there is no API key to spend, or the learner explicitly switched
 * the mock on. Guarded: safe to call from node.
 */
export function isMockMode(): boolean {
	try {
		if (typeof localStorage !== 'undefined' && localStorage.getItem(MOCK_FLAG_KEY) === '1') {
			return true;
		}
	} catch {
		/* storage disabled; fall through to the key check */
	}
	return !getApiKey();
}

/** Turns the mock on or off for this device. */
export function setMockMode(on: boolean): void {
	if (typeof localStorage === 'undefined') return;
	try {
		if (on) localStorage.setItem(MOCK_FLAG_KEY, '1');
		else localStorage.removeItem(MOCK_FLAG_KEY);
	} catch {
		/* ignore */
	}
}

const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0 };

/** Fallback meanings used as multiple-choice distractors. */
const DISTRACTORS = [
	'the window',
	'to run',
	'yesterday',
	'cheap',
	'the bridge',
	'to remember',
	'the cheese',
	'slowly'
];

/** One canned fixture set: eight challenges hanging off the scene's two words. */
interface Fixture {
	challenges: unknown[];
	/** The scene's own vocabulary, as the fixtures cite it in `itemIds`. */
	terms: string[];
}

/**
 * True when the mock should serve its non-Latin-script (pinyin) fixtures.
 *
 * Asked of the free-form `targetLanguage` the learner typed during onboarding,
 * so "zh", "Chinese" and "Mandarin Chinese" all land on the same set — via
 * `bcp47For`, which is where the app's list of what counts as Chinese lives —
 * a second alias list here could only drift from it.
 *
 * Traditional (`zh-TW`) is included deliberately: these are the only non-Latin
 * fixtures there are, and pinyin beats no mock at all.
 */
export function usesMandarinFixtures(targetLanguage: string): boolean {
	return (
		bcp47For(targetLanguage ?? '')
			.split('-')[0]
			.toLowerCase() === 'zh'
	);
}

/**
 * Every def's fixtures for one scenario, folded back into lesson order.
 *
 * `order` is a fixture's place in the *lesson*, not in the registry: a scenario
 * opens on recognition and closes on the production types, and each cloze sits
 * beside the challenge it follows on from. Sorting by it lets a def put its
 * examples wherever they read best without moving the registry's own order,
 * which is union order and escalation-gloss order and answers to those, not to
 * the mock.
 */
function scenarioChallenges(scenario: FixtureScenario): unknown[] {
	return WIRE_TYPE_DEFS.flatMap((def) => [...def.fixtures[scenario]])
		.sort((a, b) => a.order - b.order)
		.map((fixture) => fixture.challenge);
}

/** Spanish, a restaurant scene: the default mock lesson. */
function spanishRestaurant(): Fixture {
	return {
		challenges: scenarioChallenges('spanish'),
		terms: ['la cuenta', 'pedir']
	};
}

/**
 * Mandarin, the same restaurant scene, with pinyin on every target-script
 * string. Nothing in its fixtures spells a toneless variant out: the resolver
 * folds the readings, so typing "maidan" grades correct through the ordinary
 * local validator.
 */
function mandarinRestaurant(): Fixture {
	return {
		challenges: scenarioChallenges('mandarin'),
		terms: ['菜单', '买单']
	};
}

/** The fixture set for this profile. */
function fixtureFor(args: BatchArgs): Fixture {
	return usesMandarinFixtures(args.profile.targetLanguage)
		? mandarinRestaurant()
		: spanishRestaurant();
}

/**
 * The distinct words the wants are about, in first-appearance order — the
 * mock's anchors, since a scenario cannot know the learner's ids.
 */
function wantedItems(args: BatchArgs): WantItem[] {
	const seen = new Set<string>();
	const out: WantItem[] = [];
	for (const want of args.wants) {
		if (seen.has(want.item.id)) continue;
		seen.add(want.item.id);
		out.push(want.item);
	}
	return out;
}

/**
 * Two challenges per wanted word — one recognition, one production — so the
 * mock reflects the real batch shape.
 *
 * Nothing here picks a slot for the correct answer: the resolver shuffles, and
 * the mock's seeded rng makes that shuffle reproducible, so practice mode never
 * trains "always pick the first one" and never changes between runs either.
 */
function perWordChallenges(items: WantItem[]): unknown[] {
	const out: unknown[] = [];
	items.slice(0, 5).forEach((item) => {
		const others = items.filter((o) => o.id !== item.id).map((o) => o.meaning);
		const pool = [...others, ...DISTRACTORS].filter((m) => m && m !== item.meaning);
		const wrong = [...new Set(pool)].slice(0, 3);
		while (wrong.length < 3) wrong.push(`${DISTRACTORS[wrong.length]} (${wrong.length})`);

		out.push({
			type: 'recognize-mc',
			shown: { text: item.term, reading: null },
			correctMeaning: item.meaning,
			distractors: wrong,
			instruction: null,
			itemIds: [item.id],
			explanation: null
		});
		out.push({
			type: 'translate-to-target',
			promptNative: item.meaning,
			answers: [{ text: item.term, reading: null }],
			itemIds: [item.id],
			explanation: null
		});
	});
	return out;
}

/**
 * The raw completion the mock pretends to have received — fenced, exactly as a
 * cheap model would return it.
 */
export function mockBatchCompletion(args: BatchArgs): string {
	const canned = fixtureFor(args).challenges;
	const perWord = perWordChallenges(wantedItems(args));

	// Always keep the canned set — it is what makes the mock cover every
	// challenge type — and always let at least a couple of per-word challenges
	// ride along, so the mock exercises id references even when fewer challenges
	// were wanted than the canned set holds.
	const floor = canned.length + Math.min(perWord.length, 2);
	const challenges = [...canned, ...perWord].slice(0, Math.max(floor, args.wants.length));

	return '```json\n' + JSON.stringify({ challenges }, null, 1) + '\n```';
}

/**
 * The term → id index the mock hands the resolver: the real one, plus a
 * binding for each of the scenario's own words.
 *
 * The canned challenges are *about* la cuenta and pedir, and a batch introduces
 * no vocabulary, so those words are not the mock's to add. Each is bound
 * instead to one of the learner's review items, taken in order and wrapping
 * round when there are fewer of them than the scene has words. A binding never
 * overwrites a real one: a learner who genuinely has "la cuenta" gets their own
 * item, which is the whole point of resolving by term.
 *
 * With no review items at all nothing binds, the canned challenges resolve to
 * nothing and are dropped — the same answer the paid path gives a collection
 * with no vocabulary to build a lesson from.
 */
function mockTermIndex(args: BatchArgs, scenario: Fixture): Map<string, string> {
	const index = knownTermIndex(args);
	const anchors = wantedItems(args);
	if (anchors.length === 0) return index;

	scenario.terms.forEach((term, position) => {
		const key = term.trim().toLowerCase();
		if (index.has(key)) return;
		index.set(key, anchors[position % anchors.length].id);
	});
	return index;
}

/** Deterministic ids, so a mock batch is byte-identical across runs. */
function mockIdFactory(): () => string {
	let n = 0;
	return () => `mock-${String(++n).padStart(4, '0')}`;
}

/**
 * A seeded LCG standing in for `Math.random`, for the same reason as
 * {@link mockIdFactory}: the resolver shuffles options and word banks, and a
 * mock batch that reshuffled on every call would be useless as a fixture — and
 * would make the practice lesson flicker between reloads.
 */
function mockRng(): () => number {
	let seed = 0x2f6e2b1;
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
}

/**
 * A full mock batch, post-processed by the real resolver.
 *
 * Like the real path it produces challenges and nothing else: practice mode
 * cannot teach the learner a word any more than a paid batch can.
 */
export function mockBatch(args: BatchArgs, opts: BatchOptions = {}): BatchResult {
	// Same step sequence as the real path, so the learn screen's progress log is
	// identical in practice mode — every step simply lands instantly.
	opts.onProgress?.({ id: 'build-prompt', label: 'Building the prompt' });
	opts.onProgress?.({ id: 'request', label: 'Waiting for practice-mode content' });
	opts.onProgress?.({ id: 'validate', label: 'Validating challenges' });

	const resolved = resolveBatch(parseBatch(mockBatchCompletion(args)), {
		newId: opts.newId ?? mockIdFactory(),
		knownItemIds: wantedItems(args).map((i) => i.id),
		// The canned half cites its words by term, so the mock leans on exactly the
		// term-citation path a paid batch uses — with the scenario's own words bound
		// in on top. See {@link mockTermIndex}.
		termToId: mockTermIndex(args, fixtureFor(args)),
		rng: opts.rng ?? mockRng()
	});
	return { challenges: resolved.challenges, usage: NO_USAGE, failedRequests: 0 };
}

/**
 * A canned escalation reply, in the shape the UI renders.
 *
 * `overturn` is always false: only a real model can judge whether a disputed
 * answer deserves the grade, and a mock that flipped grades would quietly
 * corrupt SRS state for anyone practising without a key.
 */
export function escalateMock(args: EscalationArgs): EscalationResult {
	const answer = [
		`(mock answer — no API key set, so nothing was sent to OpenRouter)`,
		`Your answer "${args.answerGiven || '—'}" was graded "${args.verdict}".`,
		'The expected form differs in one detail, usually the verb ending or a missing article.',
		`With a key configured this paragraph would be a real explanation in ${args.nativeLanguage}, under 120 words — and a justified dispute could overturn the grade.`
	].join(' ');
	return { answer, overturn: false, usage: NO_USAGE };
}
