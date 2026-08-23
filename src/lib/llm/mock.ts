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
 *   translate-to-target and translate-to-native — with `"reading": null`
 *   throughout, as a Latin-script lesson has.
 * - **Mandarin for English speakers**, selected when the target language names
 *   Chinese: the same coverage with pinyin on every target-script string, so
 *   the romanization UI can be built and eyeballed with no API key. Set the
 *   target language to "Chinese" in onboarding to get it.
 *
 * Both sets introduce exactly two new vocabulary items.
 */

import { getApiKey } from '$lib/db/settings';
import type { TokenUsage } from './client';
import type { BatchArgs, BatchOptions, BatchResult, ReviewItemRef } from './generate';
import { MAX_BATCH_CHALLENGES, defaultChallengeCount, parseBatch, resolveBatch } from './generate';
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

/** One canned fixture set: six challenges hanging off two new items. */
interface Fixture {
	challenges: unknown[];
	newItems: unknown[];
}

/**
 * Languages whose mock batch uses the Mandarin fixtures. Matched on the
 * free-form `targetLanguage` string the learner typed during onboarding, so
 * "zh", "Chinese" and "Mandarin Chinese" all land on the same set.
 */
const MANDARIN_NAMES = /(^|\W)(zh|chinese|mandarin|putonghua|普通话|中文)(\W|$)/i;

/** True when the mock should serve its non-Latin-script (pinyin) fixtures. */
export function usesMandarinFixtures(targetLanguage: string): boolean {
	return MANDARIN_NAMES.test(targetLanguage ?? '');
}

/** Spanish, a restaurant scene: the default mock lesson. */
function spanishRestaurant(): Fixture {
	return {
		challenges: [
			{
				type: 'recognize-mc',
				shown: { text: '¿Nos trae la cuenta, por favor?', reading: null },
				correctMeaning: 'Could you bring us the bill, please?',
				distractors: [
					'Could we see the menu, please?',
					'Is this table free?',
					'Could you bring another chair?'
				],
				// Exercises the instruction field: this is a dialogue turn, not a
				// bare vocabulary lookup, so the default "What does this mean?"
				// heading undersells it.
				instruction: 'What is the customer asking for?',
				itemIds: ['new:0'],
				explanation: 'Waiters are addressed with "usted", hence "trae" rather than "traes".'
			},
			{
				type: 'cloze',
				before: { text: '¿Nos trae la ', reading: null },
				answer: { text: 'cuenta', reading: null },
				after: { text: ', por favor? Tenemos prisa.', reading: null },
				hintNative: 'Could you bring us the bill, please? We are in a hurry.',
				distractorWords: [
					{ text: 'carta', reading: null },
					{ text: 'propina', reading: null },
					{ text: 'mesa', reading: null }
				],
				itemIds: ['new:0'],
				explanation: null
			},
			{
				type: 'produce-mc',
				promptNative: 'to order (food in a restaurant)',
				correct: { text: 'pedir', reading: null },
				distractors: [
					{ text: 'pagar', reading: null },
					{ text: 'probar', reading: null },
					{ text: 'servir', reading: null }
				],
				instruction: null,
				itemIds: ['new:1'],
				explanation: null
			},
			{
				type: 'translate-to-target',
				promptNative: 'I would like to order the fish, please.',
				answers: [
					{ text: 'quisiera pedir el pescado, por favor', reading: null },
					{ text: 'quiero pedir el pescado, por favor', reading: null }
				],
				itemIds: ['new:1'],
				explanation: '"Quisiera" is the polite way to ask; "quiero" is fine but blunter.'
			},
			{
				// No distractorWords: the learner types this one.
				type: 'cloze',
				before: { text: '¿Ya podemos ', reading: null },
				answer: { text: 'pedir', reading: null },
				after: { text: '?', reading: null },
				hintNative: 'Can we order now?',
				distractorWords: null,
				itemIds: ['new:1'],
				explanation: null
			},
			{
				type: 'translate-to-native',
				prompt: { text: 'la cuenta', reading: null },
				answersNative: ['the bill', 'the check'],
				itemIds: ['new:0'],
				explanation: null
			}
		],
		newItems: [
			{ term: 'la cuenta', meaning: 'the bill', romanization: null, notes: 'feminine noun' },
			{ term: 'pedir', meaning: 'to order', romanization: null, notes: 'stem-changing: pido' }
		]
	};
}

/**
 * Mandarin, the same restaurant scene, with pinyin on every target-script
 * string. Nothing here spells a toneless variant out: the resolver folds the
 * readings, so typing "maidan" grades correct through the ordinary local
 * validator.
 */
function mandarinRestaurant(): Fixture {
	return {
		challenges: [
			{
				type: 'recognize-mc',
				shown: { text: '菜单', reading: 'càidān' },
				correctMeaning: 'the menu',
				distractors: ['the bill', 'the chopsticks', 'the waiter'],
				instruction: null,
				itemIds: ['new:0'],
				explanation: null
			},
			{
				type: 'produce-mc',
				promptNative: 'Could I see the menu?',
				correct: { text: '菜单', reading: 'càidān' },
				distractors: [
					{ text: '筷子', reading: 'kuàizi' },
					{ text: '服务员', reading: 'fúwùyuán' },
					{ text: '茶', reading: 'chá' }
				],
				instruction: null,
				itemIds: ['new:0'],
				explanation: null
			},
			{
				type: 'cloze',
				// The reading of the answer travels in `answer`, never in `before` or
				// `after`, so the pinyin line under the sentence cannot spell out the
				// word behind the blank.
				before: { text: '你好，请给我一份', reading: 'Nǐ hǎo, qǐng gěi wǒ yī fèn' },
				answer: { text: '菜单', reading: 'càidān' },
				after: { text: '。', reading: '.' },
				hintNative: 'Hello, could I have a menu, please?',
				distractorWords: [
					{ text: '筷子', reading: 'kuàizi' },
					{ text: '茶', reading: 'chá' },
					{ text: '水', reading: 'shuǐ' }
				],
				itemIds: ['new:0'],
				explanation: '份 (fèn) is the measure word for a menu or a portion.'
			},
			{
				type: 'translate-to-target',
				promptNative: 'Excuse me, the bill please.',
				answers: [
					{ text: '服务员，买单', reading: 'fúwùyuán, mǎidān' },
					{ text: '买单', reading: 'mǎidān' }
				],
				itemIds: ['new:1'],
				explanation: 'Calling 服务员 (fúwùyuán) across the room is normal, not rude.'
			},
			{
				type: 'cloze',
				before: { text: '我们想', reading: 'Wǒmen xiǎng' },
				answer: { text: '买单', reading: 'mǎidān' },
				after: { text: '。', reading: '.' },
				hintNative: 'We would like to pay the bill.',
				distractorWords: null,
				itemIds: ['new:1'],
				explanation: null
			},
			{
				type: 'translate-to-native',
				prompt: { text: '买单', reading: 'mǎidān' },
				answersNative: ['to pay the bill', 'pay the bill'],
				itemIds: ['new:1'],
				explanation: null
			}
		],
		newItems: [
			{ term: '菜单', meaning: 'the menu', romanization: 'càidān', notes: null },
			{
				term: '买单',
				meaning: 'to pay the bill',
				romanization: 'mǎidān',
				notes: 'colloquial; 结账 (jiézhàng) is the neutral form'
			}
		]
	};
}

/** The fixture set for this profile. */
function fixtureFor(args: BatchArgs): Fixture {
	return usesMandarinFixtures(args.profile.targetLanguage)
		? mandarinRestaurant()
		: spanishRestaurant();
}

/**
 * Two challenges per review item — one recognition, one production — so the
 * mock reflects the real batch shape.
 *
 * Nothing here picks a slot for the correct answer: the resolver shuffles, and
 * the mock's seeded rng makes that shuffle reproducible, so practice mode never
 * trains "always pick the first one" and never changes between runs either.
 */
function reviewChallenges(items: ReviewItemRef[]): unknown[] {
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
	const count = Math.min(
		args.count ?? defaultChallengeCount(args.reviewItems.length, args.newItemSlots),
		MAX_BATCH_CHALLENGES
	);
	const fixture = fixtureFor(args);
	const review = reviewChallenges(args.reviewItems);

	// Always keep the canned six: they are what makes the mock cover every
	// challenge type and both new items.
	const challenges = [...fixture.challenges, ...review].slice(
		0,
		Math.max(fixture.challenges.length, count)
	);

	const batch = { challenges, newItems: fixture.newItems };

	return '```json\n' + JSON.stringify(batch, null, 1) + '\n```';
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
 * Like the real path, `newItems` come back with `fsrsCard: null` for the caller
 * to initialize.
 */
export function mockBatch(args: BatchArgs, opts: BatchOptions = {}): BatchResult {
	// Same step sequence as the real path, so the learn screen's progress log is
	// identical in practice mode — every step simply lands instantly.
	opts.onProgress?.({ id: 'build-prompt', label: 'Building the prompt' });
	opts.onProgress?.({ id: 'request', label: 'Waiting for practice-mode content' });
	opts.onProgress?.({ id: 'validate', label: 'Validating challenges' });

	const resolved = resolveBatch(parseBatch(mockBatchCompletion(args)), {
		newId: opts.newId ?? mockIdFactory(),
		now: opts.now ?? (() => 0),
		knownItemIds: args.reviewItems.map((i) => i.id),
		rng: opts.rng ?? mockRng()
	});
	return { challenges: resolved.challenges, newItems: resolved.newItems, usage: NO_USAGE };
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
