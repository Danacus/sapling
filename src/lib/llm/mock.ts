/**
 * Mock mode: a full lesson batch with no API key and no network.
 *
 * The fixtures are deterministic and go through the *same* parse/resolve path
 * as a real completion — they are emitted as a fenced JSON string and fed to
 * `parseBatch` + `resolveBatch` — so developing against the mock exercises the
 * real code, not a parallel happy path.
 *
 * Content is Spanish-for-English-speakers, mixed directions, covering
 * multiple-choice, cloze (with and without a word bank) and typed translation,
 * plus two new vocabulary items.
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

/** The five canned challenges, all hanging off the two mock `newItems`. */
function cannedChallenges(): unknown[] {
	return [
		{
			type: 'multiple-choice',
			direction: 'toNative',
			prompt: 'la biblioteca',
			options: ['the library', 'the bookshop', 'the office', 'the kitchen'],
			correctIndex: 0,
			itemIds: ['new:0'],
			explanation: 'A "biblioteca" lends books; a "librería" sells them.'
		},
		{
			type: 'cloze',
			direction: 'toTarget',
			sentence: 'Voy a la ___ para leer un libro.',
			acceptedAnswers: ['biblioteca', 'la biblioteca'],
			wordBank: ['biblioteca', 'cocina', 'oficina', 'tienda'],
			translationHint: 'I go to the library to read a book.',
			itemIds: ['new:0'],
			explanation: null
		},
		{
			type: 'multiple-choice',
			direction: 'toTarget',
			prompt: 'early',
			options: ['tarde', 'temprano', 'luego', 'ahora'],
			correctIndex: 1,
			itemIds: ['new:1'],
			explanation: null
		},
		{
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: 'I get up early',
			acceptedAnswers: ['me levanto temprano', 'me despierto temprano', 'yo me levanto temprano'],
			itemIds: ['new:1'],
			explanation: null
		},
		{
			type: 'cloze',
			direction: 'toNative',
			sentence: 'The train leaves ___ in the morning.',
			acceptedAnswers: ['early'],
			wordBank: null,
			translationHint: 'El tren sale temprano por la mañana.',
			itemIds: ['new:1'],
			explanation: null
		}
	];
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
			options,
			correctIndex,
			itemIds: [item.id],
			explanation: null
		});
		out.push({
			type: 'typed-translation',
			direction: 'toTarget',
			prompt: item.meaning,
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
	const canned = cannedChallenges();
	const review = reviewChallenges(args.reviewItems);

	// Always keep the canned five: they are what makes the mock cover every
	// challenge type and both new items.
	const challenges = [...canned, ...review].slice(0, Math.max(canned.length, count));

	const batch = {
		challenges,
		newItems: [
			{ term: 'la biblioteca', meaning: 'the library', notes: 'feminine noun' },
			{ term: 'temprano', meaning: 'early', notes: null }
		]
	};

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
