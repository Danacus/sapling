import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '$lib/types';
import type { FetchLike } from './client';
import { LlmError } from './client';
import {
	MAX_BATCH_CHALLENGES,
	buildBatchPrompt,
	defaultChallengeCount,
	generateBatch,
	makeMatchPairsChallenge,
	parseBatch,
	resolveBatch,
	stripFences
} from './generate';
import type { BatchArgs, ProgressStep } from './generate';
import { challengeSchema } from './schemas';

const args: BatchArgs = {
	profile: {
		nativeLanguage: 'English',
		targetLanguage: 'Spanish',
		level: 'beginner',
		interests: ['cooking', 'cycling']
	},
	reviewItems: [
		{ id: 'i1', term: 'el perro', meaning: 'the dog' },
		{ id: 'i2', term: 'leer', meaning: 'to read' }
	],
	newItemSlots: 2
};

function mc(itemId: string, prompt: string) {
	return {
		type: 'multiple-choice',
		direction: 'toNative',
		prompt,
		options: ['the dog', 'the cat', 'the bread', 'the house'],
		correctIndex: 0,
		itemIds: [itemId],
		explanation: null
	};
}

function tt(itemId: string, prompt: string) {
	return {
		type: 'typed-translation',
		direction: 'toTarget',
		prompt,
		acceptedAnswers: ['el perro'],
		itemIds: [itemId]
	};
}

const cloze = {
	type: 'cloze',
	direction: 'toTarget',
	sentence: 'Yo ___ un libro.',
	acceptedAnswers: ['leo'],
	wordBank: ['leo', 'como', 'bebo', 'corro'],
	translationHint: 'I read a book.',
	itemIds: ['new:0'],
	explanation: 'leer -> leo in the first person.'
};

const goodBatch = {
	challenges: [
		mc('i1', 'el perro'),
		tt('i1', 'the dog'),
		mc('i2', 'leer'),
		cloze,
		tt('new:0', 'to read'),
		{ ...mc('new:1', 'temprano'), options: ['early', 'late', 'now', 'soon'] }
	],
	newItems: [
		{ term: 'leer', meaning: 'to read', notes: 'irregular in some tenses' },
		{ term: 'temprano', meaning: 'early', notes: null }
	]
};

/** Replies with the given raw completion contents, one per call. */
function scriptedFetch(contents: string[]): { fetchFn: FetchLike; calls: number } {
	const state = { fetchFn: null as unknown as FetchLike, calls: 0 };
	state.fetchFn = async () => {
		const content = contents[Math.min(state.calls, contents.length - 1)];
		state.calls++;
		return new Response(
			JSON.stringify({
				model: 'test/model',
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 600, completion_tokens: 900 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return state as { fetchFn: FetchLike; calls: number };
}

const callOpts = (fetchFn: FetchLike) => ({
	fetchFn,
	apiKey: 'sk-or-test',
	model: 'test/model',
	now: () => 1700000000000,
	newId: idFactory()
});

function idFactory(): () => string {
	let n = 0;
	return () => `id-${++n}`;
}

describe('stripFences', () => {
	it('leaves bare JSON alone', () => {
		expect(stripFences('{"a":1}')).toBe('{"a":1}');
	});

	it('unwraps ```json fences', () => {
		expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
		expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
	});

	it('salvages JSON buried in chatter', () => {
		expect(stripFences('Sure! Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
	});
});

describe('buildBatchPrompt', () => {
	const messages = buildBatchPrompt(args);

	it('is exactly one system and one user message', () => {
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe('system');
		expect(messages[1].role).toBe('user');
	});

	it('states every challenge type and the itemIds contract in the system message', () => {
		const system = messages[0].content;
		expect(system).toContain('multiple-choice');
		expect(system).toContain('cloze');
		expect(system).toContain('typed-translation');
		expect(system).not.toContain('match-pairs');
		expect(system).toContain('new:<index>');
	});

	it('packs the data as compact JSON, no prose', () => {
		const payload = JSON.parse(messages[1].content) as Record<string, unknown>;
		expect(payload.native).toBe('English');
		expect(payload.target).toBe('Spanish');
		expect(payload.level).toBe('beginner');
		expect(payload.newItemSlots).toBe(2);
		expect(payload.challengeCount).toBe(8);
		expect(payload.reviewItems).toEqual([
			{ id: 'i1', t: 'el perro', m: 'the dog' },
			{ id: 'i2', t: 'leer', m: 'to read' }
		]);
		expect(payload.recentMistakes).toBeUndefined();
	});

	it('includes recent mistakes when supplied', () => {
		const withMistakes = buildBatchPrompt({
			...args,
			recentMistakes: [
				{ term: 'leer', gave: 'lees' },
				{ term: 'temprano', gave: '(skipped)' }
			]
		});
		const payload = JSON.parse(withMistakes[1].content) as Record<string, unknown>;
		expect(payload.recentMistakes).toEqual([
			{ t: 'leer', gave: 'lees' },
			{ t: 'temprano', gave: '(skipped)' }
		]);
	});

	it('includes recentAccuracy, rounded to two decimals', () => {
		const payload = JSON.parse(
			buildBatchPrompt({ ...args, recentAccuracy: 0.666666 })[1].content
		) as Record<string, unknown>;
		expect(payload.recentAccuracy).toBe(0.67);
	});

	it('omits recentAccuracy when there is no history to report', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('recentAccuracy');
	});

	it('states the difficulty-calibration rules in the system message', () => {
		const system = messages[0].content;
		expect(system).toContain('recentAccuracy');
		expect(system).toContain('recentMistakes');
		expect(system).toContain('0.7');
		expect(system).toContain('0.85');
		expect(system).toContain('wordBank');
		expect(system).toContain('(skipped)');
	});

	it('caps the derived count', () => {
		expect(defaultChallengeCount(2, 2)).toBe(8);
		expect(defaultChallengeCount(40, 5)).toBe(MAX_BATCH_CHALLENGES);
	});

	it('threads the session topic into the user message, ahead of interests', () => {
		const withTopic = buildBatchPrompt({ ...args, topic: 'ordering in a restaurant' });
		const raw = withTopic[1].content;
		expect(raw).toContain('ordering in a restaurant');

		const payload = JSON.parse(raw) as Record<string, unknown>;
		expect(payload.topic).toBe('ordering in a restaurant');
		const keys = Object.keys(payload);
		expect(keys.indexOf('topic')).toBeLessThan(keys.indexOf('interests'));
	});

	it('omits the topic key entirely when there is none', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('topic');
		const blank = buildBatchPrompt({ ...args, topic: '   ' });
		expect(JSON.parse(blank[1].content)).not.toHaveProperty('topic');
	});

	it('states the conversational and romanization rules in the system message', () => {
		const system = messages[0].content;
		// The user's complaint: interests produced "I like to cook" sentences.
		expect(system).toContain('I like <interest>');
		expect(system).toContain('topic');
		expect(system).toContain('promptRomanization');
		expect(system).toContain('optionsRomanization');
		expect(system).toContain('sentenceRomanization');
		expect(system).toContain('pinyin');
		// The rule that keeps grading local and free for non-Latin scripts.
		expect(system).toContain('acceptedAnswers must ALSO list the romanized form');
	});

	it('requires a cloze romanization to keep the ___ gap', () => {
		const system = messages[0].content;
		expect(system).toContain('sentenceRomanization mirrors the cloze sentence INCLUDING the ___');
		expect(system).toContain('never write the reading of the blanked word');
		// Shown, not just told.
		expect(system).toContain('Nǐ hǎo, qǐng gěi wǒ yī fèn ___.');
	});

	it('demands challenges that are answerable from what is shown', () => {
		const system = messages[0].content;
		// The user's complaint: "where is the fish stall?" with an answer only the
		// model could know.
		expect(system).toContain('Answerable from what is shown alone');
		expect(system).toContain('uniquely determine the answer');
		expect(system).toMatch(/facts you never state/i);
		expect(system).toContain("Say: 'the fish stall is to the right'");
		expect(system).toContain('exactly one option may be correct');
	});
});

describe('generateBatch', () => {
	it('assigns ids, resolves new:<i> and builds KnowledgeItems', async () => {
		const scripted = scriptedFetch([JSON.stringify(goodBatch)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(result.challenges).toHaveLength(6);
		expect(result.usage).toEqual({ promptTokens: 600, completionTokens: 900 });

		// Every emitted challenge is a valid domain Challenge.
		for (const challenge of result.challenges) {
			expect(challengeSchema.safeParse(challenge).success).toBe(true);
			expect(challenge.id).toMatch(/^id-\d+$/);
		}

		expect(result.newItems).toHaveLength(2);
		const [leer, temprano] = result.newItems;
		expect(leer).toMatchObject({
			kind: 'vocab',
			term: 'leer',
			meaning: 'to read',
			notes: 'irregular in some tenses',
			fsrsCard: null,
			introducedAt: 1700000000000,
			history: []
		});
		// `notes: null` is normalized away rather than stored as null.
		expect('notes' in temprano).toBe(false);

		// `new:0` now points at the generated id, not the placeholder.
		const clozeOut = result.challenges.find((c) => c.type === 'cloze');
		expect(clozeOut?.itemIds).toEqual([leer.id]);
		expect(result.challenges.flatMap((c) => c.itemIds)).not.toContain('new:0');

		// Existing ids pass through untouched.
		expect(result.challenges[0].itemIds).toEqual(['i1']);
	});

	it('strips markdown fences around the JSON', async () => {
		const scripted = scriptedFetch(['```json\n' + JSON.stringify(goodBatch) + '\n```']);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		expect(result.challenges).toHaveLength(6);
	});

	it('salvages the batch when a single challenge is malformed', async () => {
		const damaged = {
			...goodBatch,
			challenges: [
				...goodBatch.challenges,
				{ type: 'multiple-choice', direction: 'toNative', prompt: 'x', options: ['a', 'b'] }
			]
		};
		const scripted = scriptedFetch([JSON.stringify(damaged)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(result.challenges).toHaveLength(6);
		expect(scripted.calls).toBe(1);
	});

	it('drops challenges that reference an id the model invented', async () => {
		const hallucinated = {
			...goodBatch,
			challenges: [...goodBatch.challenges, mc('i-does-not-exist', 'ghost')]
		};
		const scripted = scriptedFetch([JSON.stringify(hallucinated)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		expect(result.challenges).toHaveLength(6);
	});

	it('retries once with a corrective instruction, then succeeds', async () => {
		const thin = { challenges: [mc('i1', 'el perro')], newItems: [] };
		const scripted = scriptedFetch([JSON.stringify(thin), JSON.stringify(goodBatch)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(scripted.calls).toBe(2);
		expect(result.challenges).toHaveLength(6);
		// Usage is summed across both attempts.
		expect(result.usage).toEqual({ promptTokens: 1200, completionTokens: 1800 });
	});

	it('throws bad-response after the retry also fails', async () => {
		const scripted = scriptedFetch(['not json at all', 'still not json']);
		const error = await generateBatch(args, callOpts(scripted.fetchFn)).catch(
			(e: unknown) => e
		);

		expect(scripted.calls).toBe(2);
		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('bad-response');
	});

	it('throws bad-response when too few challenges survive twice', async () => {
		const thin = JSON.stringify({ challenges: [mc('i1', 'el perro')], newItems: [] });
		const scripted = scriptedFetch([thin, thin]);
		await expect(generateBatch(args, callOpts(scripted.fetchFn))).rejects.toMatchObject({
			kind: 'bad-response'
		});
		expect(scripted.calls).toBe(2);
	});

	it('reports its progress steps in order, naming the model it waits on', async () => {
		const scripted = scriptedFetch([JSON.stringify(goodBatch)]);
		const steps: ProgressStep[] = [];
		await generateBatch(args, { ...callOpts(scripted.fetchFn), onProgress: (s) => steps.push(s) });

		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
		expect(steps[1].label).toContain('test/model');
		for (const step of steps) expect(step.label.length).toBeGreaterThan(0);
	});

	it('reports the retry step only when the corrective retry fires', async () => {
		const thin = { challenges: [mc('i1', 'el perro')], newItems: [] };
		const scripted = scriptedFetch([JSON.stringify(thin), JSON.stringify(goodBatch)]);
		const steps: ProgressStep[] = [];
		await generateBatch(args, { ...callOpts(scripted.fetchFn), onProgress: (s) => steps.push(s) });

		expect(steps.map((s) => s.id)).toEqual([
			'build-prompt',
			'request',
			'validate',
			'retry',
			'request',
			'validate'
		]);
	});

	it('does not demand five challenges from a two-challenge batch', async () => {
		const tiny = JSON.stringify({ challenges: [mc('i1', 'el perro')], newItems: [] });
		const scripted = scriptedFetch([tiny]);
		const result = await generateBatch(
			{ ...args, newItemSlots: 0, reviewItems: args.reviewItems.slice(0, 1), count: 1 },
			callOpts(scripted.fetchFn)
		);
		expect(scripted.calls).toBe(1);
		expect(result.challenges).toHaveLength(1);
	});
});

describe('resolveBatch', () => {
	it('discards new items no challenge actually uses', () => {
		const parsed = parseBatch(
			JSON.stringify({
				challenges: [mc('new:0', 'x')],
				newItems: [
					{ term: 'a', meaning: 'A' },
					{ term: 'b', meaning: 'B' }
				]
			})
		);
		const resolved = resolveBatch(parsed, { newId: idFactory(), now: () => 0 });
		expect(resolved.newItems).toHaveLength(1);
		expect(resolved.newItems[0].term).toBe('a');
		expect(resolved.challenges[0].itemIds).toEqual([resolved.newItems[0].id]);
	});

	it('drops a challenge whose every reference is unresolvable', () => {
		const parsed = parseBatch(
			JSON.stringify({ challenges: [mc('new:9', 'x')], newItems: [] })
		);
		const resolved = resolveBatch(parsed, { newId: idFactory(), now: () => 0 });
		expect(resolved.challenges).toHaveLength(0);
		expect(resolved.dropped).toBe(1);
	});

	it('counts malformed entries as dropped rather than failing', () => {
		const parsed = parseBatch(
			JSON.stringify({ challenges: [mc('i1', 'ok'), { type: 'cloze' }], newItems: [{}] })
		);
		expect(parsed.challenges).toHaveLength(1);
		expect(parsed.dropped).toBe(2);
	});

	it('rejects a completion whose envelope is the wrong shape', () => {
		expect(() => parseBatch('{"challenges":"nope"}')).toThrow(LlmError);
	});

	it('copies romanization onto built KnowledgeItems and challenges', () => {
		const parsed = parseBatch(
			JSON.stringify({
				challenges: [
					{
						type: 'multiple-choice',
						direction: 'toTarget',
						prompt: 'the menu',
						promptRomanization: null,
						options: ['菜单', '筷子', '服务员', '茶'],
						optionsRomanization: ['càidān', 'kuàizi', 'fúwùyuán', 'chá'],
						correctIndex: 0,
						itemIds: ['new:0']
					},
					{
						type: 'cloze',
						direction: 'toTarget',
						sentence: '请给我一份___。',
						sentenceRomanization: 'Qǐng gěi wǒ yī fèn ___.',
						acceptedAnswers: ['菜单', 'càidān', 'caidan'],
						translationHint: 'Please give me a menu.',
						itemIds: ['new:0']
					},
					{
						type: 'typed-translation',
						direction: 'toNative',
						prompt: '买单',
						promptRomanization: 'mǎidān',
						acceptedAnswers: ['the bill'],
						itemIds: ['new:1']
					}
				],
				newItems: [
					{ term: '菜单', meaning: 'the menu', romanization: 'càidān' },
					{ term: '买单', meaning: 'to pay the bill', romanization: '  mǎidān  ' }
				]
			})
		);
		const resolved = resolveBatch(parsed, { newId: idFactory(), now: () => 0 });

		expect(resolved.newItems.map((i) => i.romanization)).toEqual(['càidān', 'mǎidān']);

		const [mc, cloze, typed] = resolved.challenges;
		expect(mc.type === 'multiple-choice' && mc.optionsRomanization).toEqual([
			'càidān',
			'kuàizi',
			'fúwùyuán',
			'chá'
		]);
		// A null romanization becomes an absent key, not `undefined`.
		expect(mc.type === 'multiple-choice' && 'promptRomanization' in mc).toBe(false);
		expect(cloze.type === 'cloze' && cloze.sentenceRomanization).toBe(
			'Qǐng gěi wǒ yī fèn ___.'
		);
		expect(typed.type === 'typed-translation' && typed.promptRomanization).toBe('mǎidān');

		for (const challenge of resolved.challenges) {
			expect(challengeSchema.safeParse(challenge).success).toBe(true);
		}
	});

	/**
	 * The user's complaint: with romanization on, the pinyin under a cloze
	 * spelled out the word the blank was hiding. A reading that lost the gap has
	 * romanized the answer along with everything else, so it is dropped.
	 */
	describe('the cloze romanization gap guard', () => {
		function clozeBatch(sentence: string, sentenceRomanization: string) {
			return JSON.stringify({
				challenges: [
					{
						type: 'cloze',
						direction: 'toTarget',
						sentence,
						sentenceRomanization,
						acceptedAnswers: ['菜单'],
						translationHint: 'Please give me a menu.',
						itemIds: ['i1']
					}
				],
				newItems: []
			});
		}

		function resolveCloze(sentence: string, sentenceRomanization: string) {
			const resolved = resolveBatch(parseBatch(clozeBatch(sentence, sentenceRomanization)), {
				newId: idFactory(),
				now: () => 0
			});
			const [challenge] = resolved.challenges;
			return challenge?.type === 'cloze' ? challenge : undefined;
		}

		it('keeps a reading that still carries the gap', () => {
			const cloze = resolveCloze('请给我一份___。', 'Qǐng gěi wǒ yī fèn ___.');
			expect(cloze?.sentenceRomanization).toBe('Qǐng gěi wǒ yī fèn ___.');
		});

		it('strips a reading that spells the blanked word out', () => {
			const cloze = resolveCloze('请给我一份___。', 'Qǐng gěi wǒ yī fèn càidān.');
			// The challenge survives; only the spoiler goes.
			expect(cloze).toBeDefined();
			expect('sentenceRomanization' in (cloze ?? {})).toBe(false);
			expect(cloze?.sentence).toBe('请给我一份___。');
		});
	});

	it('leaves romanization keys off entirely for a Latin-script batch', () => {
		const parsed = parseBatch(JSON.stringify(goodBatch));
		const resolved = resolveBatch(parsed, { newId: idFactory(), now: () => 0 });
		expect(JSON.stringify(resolved)).not.toContain('omanization');
	});

	it('drops a misaligned optionsRomanization instead of the whole challenge', () => {
		const parsed = parseBatch(
			JSON.stringify({
				challenges: [{ ...mc('i1', 'el perro'), optionsRomanization: ['a', 'b'] }],
				newItems: []
			})
		);
		const resolved = resolveBatch(parsed, { newId: idFactory(), now: () => 0 });
		expect(resolved.challenges).toHaveLength(1);
		expect(resolved.challenges[0]).not.toHaveProperty('optionsRomanization');
	});
});

describe('makeMatchPairsChallenge', () => {
	const items: KnowledgeItem[] = ['perro', 'gato', 'casa', 'pan', 'agua'].map((term, i) => ({
		id: `k${i}`,
		kind: 'vocab',
		term,
		meaning: `meaning-${i}`,
		fsrsCard: null,
		introducedAt: 0,
		history: []
	}));

	it('returns undefined below four items', () => {
		expect(makeMatchPairsChallenge(items.slice(0, 3))).toBeUndefined();
		expect(makeMatchPairsChallenge([])).toBeUndefined();
	});

	it('builds a valid four-to-five pair challenge with no tokens spent', () => {
		const challenge = makeMatchPairsChallenge(items, () => 0.5);
		expect(challenge).toBeDefined();
		expect(challenge?.type).toBe('match-pairs');
		expect(challengeSchema.safeParse(challenge).success).toBe(true);

		const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
		expect(pairs.length).toBeGreaterThanOrEqual(4);
		expect(pairs.length).toBeLessThanOrEqual(5);
		expect(challenge?.itemIds).toHaveLength(pairs.length);
		for (const pair of pairs) {
			const source = items.find((i) => i.term === pair.a);
			expect(source?.meaning).toBe(pair.b);
		}
	});

	it('ignores items missing a term or meaning', () => {
		const broken = [...items.slice(0, 3), { ...items[3], meaning: '  ' }];
		expect(makeMatchPairsChallenge(broken)).toBeUndefined();
	});

	it('carries the term romanization as aRom when the item has one', () => {
		const zhItems: KnowledgeItem[] = [
			{ term: '菜单', meaning: 'the menu', romanization: 'càidān' },
			{ term: '买单', meaning: 'to pay the bill', romanization: 'mǎidān' },
			{ term: '筷子', meaning: 'chopsticks', romanization: 'kuàizi' },
			{ term: '茶', meaning: 'tea', romanization: 'chá' }
		].map((partial, i) => ({
			id: `z${i}`,
			kind: 'vocab' as const,
			fsrsCard: null,
			introducedAt: 0,
			history: [],
			...partial
		}));

		const challenge = makeMatchPairsChallenge(zhItems, () => 0.5);
		expect(challengeSchema.safeParse(challenge).success).toBe(true);
		const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
		for (const pair of pairs) {
			expect(pair.aRom).toBe(zhItems.find((i) => i.term === pair.a)?.romanization);
			// `b` is already in the native language, so it never gets a reading.
			expect('bRom' in pair).toBe(false);
		}
		// Latin-script items add no romanization keys at all.
		expect(JSON.stringify(makeMatchPairsChallenge(items, () => 0.5))).not.toContain('Rom');
	});

	describe('duplicate tile labels', () => {
		/** Two identical tiles are unplayable: the learner has to guess which twin is which. */
		const withMeaningClash: KnowledgeItem[] = [
			...items,
			{
				id: 'k5',
				kind: 'vocab',
				term: 'pronto',
				// A synonym of k0: distinct term, same meaning tile.
				meaning: 'meaning-0',
				fsrsCard: null,
				introducedAt: 0,
				history: []
			}
		];

		it('never emits the same label twice on either side', () => {
			for (let seed = 0; seed < 20; seed++) {
				const challenge = makeMatchPairsChallenge(withMeaningClash, () => seed / 20);
				const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
				expect(pairs.length).toBeGreaterThanOrEqual(4);
				expect(new Set(pairs.map((p) => p.a)).size).toBe(pairs.length);
				expect(new Set(pairs.map((p) => p.b)).size).toBe(pairs.length);
			}
		});

		it('matches collisions case- and whitespace-insensitively', () => {
			const shouty = [
				...items.slice(0, 5),
				{ ...items[0], id: 'k9', term: '  PERRO  ', meaning: 'the hound' }
			];
			for (let seed = 0; seed < 20; seed++) {
				const challenge = makeMatchPairsChallenge(shouty, () => seed / 20);
				const pairs = challenge?.type === 'match-pairs' ? challenge.pairs : [];
				const keys = pairs.map((p) => p.a.trim().toLowerCase());
				expect(new Set(keys).size).toBe(pairs.length);
			}
		});

		it('returns undefined when excluding the collision leaves fewer than four items', () => {
			const four = [
				...items.slice(0, 3),
				{ ...items[3], id: 'k9', term: 'temprano', meaning: 'meaning-0' }
			];
			expect(makeMatchPairsChallenge(four, () => 0.5)).toBeUndefined();
		});
	});
});
