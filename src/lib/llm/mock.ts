/**
 * Mock mode: a full lesson batch with no API key and no network.
 *
 * The fixtures are deterministic and go through the *same* parse/resolve path
 * as a real completion — they are emitted as a fenced JSON string and fed to
 * `parseBatch` + `resolveBatch` — so developing against the mock exercises the
 * real code, not a parallel happy path.
 *
 * Two fixture sets, chosen by the profile's target language, each a small
 * restaurant scene so the mock shows off what a topic-driven batch looks like:
 *
 * - **Spanish for English speakers** (the default): mixed directions, covering
 *   multiple-choice, cloze with and without a word bank, and typed translation.
 * - **Mandarin for English speakers**, selected when the target language names
 *   Chinese: the same coverage plus pinyin on every target-script string, so
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

function stripAccents(value: string): string {
	return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** One canned fixture set: five challenges hanging off two new items. */
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
				type: 'multiple-choice',
				direction: 'toNative',
				prompt: '¿Nos trae la cuenta, por favor?',
				options: [
					'Could you bring us the bill, please?',
					'Could we see the menu, please?',
					'Is this table free?',
					'Could you bring another chair?'
				],
				correctIndex: 0,
				itemIds: ['new:0'],
				explanation: 'Waiters are addressed with "usted", hence "trae" rather than "traes".'
			},
			{
				type: 'cloze',
				direction: 'toTarget',
				sentence: '¿Nos trae la ___, por favor? Tenemos prisa.',
				acceptedAnswers: ['cuenta', 'la cuenta'],
				wordBank: ['cuenta', 'carta', 'propina', 'mesa'],
				translationHint: 'Could you bring us the bill, please? We are in a hurry.',
				itemIds: ['new:0'],
				explanation: null
			},
			{
				type: 'multiple-choice',
				direction: 'toTarget',
				prompt: 'to order (food in a restaurant)',
				options: ['pedir', 'pagar', 'probar', 'servir'],
				correctIndex: 0,
				itemIds: ['new:1'],
				explanation: null
			},
			{
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'I would like to order the fish, please.',
				acceptedAnswers: [
					'quiero pedir el pescado, por favor',
					'quiero pedir el pescado por favor',
					'quisiera pedir el pescado, por favor',
					'quisiera pedir el pescado por favor'
				],
				itemIds: ['new:1'],
				explanation: '"Quisiera" is the polite way to ask; "quiero" is fine but blunter.'
			},
			{
				type: 'cloze',
				direction: 'toNative',
				sentence: '"¿Ya saben qué van a pedir?" — "Yes, we are ready to ___."',
				acceptedAnswers: ['order'],
				wordBank: null,
				translationHint: '"¿Ya saben qué van a pedir?" — "Sí, ya podemos pedir."',
				itemIds: ['new:1'],
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
 * string — and, for the typed challenges, toneless pinyin in `acceptedAnswers`
 * so typing "maidan" grades correct through the ordinary local validator.
 */
function mandarinRestaurant(): Fixture {
	return {
		challenges: [
			{
				type: 'multiple-choice',
				direction: 'toNative',
				prompt: '菜单',
				promptRomanization: 'càidān',
				options: ['the menu', 'the bill', 'the chopsticks', 'the waiter'],
				optionsRomanization: null,
				correctIndex: 0,
				itemIds: ['new:0'],
				explanation: null
			},
			{
				type: 'multiple-choice',
				direction: 'toTarget',
				prompt: 'Could I see the menu?',
				promptRomanization: null,
				options: ['菜单', '筷子', '服务员', '茶'],
				optionsRomanization: ['càidān', 'kuàizi', 'fúwùyuán', 'chá'],
				correctIndex: 0,
				itemIds: ['new:0'],
				explanation: null
			},
			{
				type: 'cloze',
				direction: 'toTarget',
				sentence: '你好，请给我一份___。',
				sentenceRomanization: 'Nǐ hǎo, qǐng gěi wǒ yī fèn càidān.',
				acceptedAnswers: ['菜单', 'càidān', 'caidan'],
				wordBank: ['菜单', '筷子', '茶', '水'],
				translationHint: 'Hello, could I have a menu, please?',
				itemIds: ['new:0'],
				explanation: '份 (fèn) is the measure word for a menu or a portion.'
			},
			{
				type: 'typed-translation',
				direction: 'toTarget',
				prompt: 'Excuse me, the bill please.',
				promptRomanization: null,
				acceptedAnswers: [
					'服务员，买单',
					'买单',
					'fúwùyuán, mǎidān',
					'fuwuyuan, maidan',
					'mǎidān',
					'maidan'
				],
				itemIds: ['new:1'],
				explanation: 'Calling 服务员 (fúwùyuán) across the room is normal, not rude.'
			},
			{
				type: 'cloze',
				direction: 'toNative',
				sentence: '"你们要买单吗?" — "Yes, could we ___ now?"',
				sentenceRomanization: null,
				acceptedAnswers: ['pay', 'pay the bill'],
				wordBank: null,
				translationHint: '"你们要买单吗？" — "对，我们想买单。"',
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

/** Two challenges per review item, so the mock reflects the real batch shape. */
function reviewChallenges(items: ReviewItemRef[]): unknown[] {
	const out: unknown[] = [];
	items.slice(0, 5).forEach((item, index) => {
		const others = items.filter((o) => o.id !== item.id).map((o) => o.meaning);
		const pool = [...others, ...DISTRACTORS].filter((m) => m && m !== item.meaning);
		const wrong = [...new Set(pool)].slice(0, 3);
		while (wrong.length < 3) wrong.push(`${DISTRACTORS[wrong.length]} (${wrong.length})`);

		// Rotate the correct slot so the mock never trains "always pick A".
		const correctIndex = index % 4;
		const options = [...wrong];
		options.splice(correctIndex, 0, item.meaning);

		out.push({
			type: 'multiple-choice',
			direction: 'toNative',
			prompt: item.term,
			promptRomanization: null,
			options,
			optionsRomanization: null,
			correctIndex,
			itemIds: [item.id],
			explanation: null
		});
		out.push({
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: item.meaning,
			promptRomanization: null,
			acceptedAnswers: [...new Set([item.term, stripAccents(item.term)])],
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

	// Always keep the canned five: they are what makes the mock cover every
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
		knownItemIds: args.reviewItems.map((i) => i.id)
	});
	return { challenges: resolved.challenges, newItems: resolved.newItems, usage: NO_USAGE };
}

/** A canned escalation reply, in the shape the UI renders. */
export function escalateMock(args: EscalationArgs): EscalationResult {
	const answer = [
		`(mock answer — no API key set, so nothing was sent to OpenRouter)`,
		`Your answer "${args.answerGiven || '—'}" was graded "${args.verdict}".`,
		'The expected form differs in one detail, usually the verb ending or a missing article.',
		`With a key configured this paragraph would be a real explanation in ${args.nativeLanguage}, under 120 words.`
	].join(' ');
	return { answer, usage: NO_USAGE };
}
