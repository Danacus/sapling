import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '$lib/types';
import type { FetchLike } from './client';
import { LlmError } from './client';
import {
	MAX_ABOUT_CHARS,
	MAX_BATCH_CHALLENGES,
	MAX_WORD_ORDER_DISTRACTORS,
	buildBatchPrompt,
	defaultChallengeCount,
	generateBatch,
	makeMatchPairsChallenge,
	parseBatch,
	resolveBatch,
	stripFences
} from './generate';
import type { BatchArgs, ProgressStep, ResolveOptions } from './generate';
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

/**
 * `rng` of 0 sends Fisher-Yates through the same swaps every time, which lands
 * the correct choice last — so a test can assert on an exact index without
 * hard-coding what the shuffle "happens" to do.
 */
const ZERO_RNG = () => 0;
/** The opposite extreme: `j === i` at every step, so nothing moves at all. */
const IDENTITY_RNG = () => 0.999999;

function recognize(itemId: string, term: string, meaning = 'the dog') {
	return {
		type: 'recognize-mc',
		shown: { text: term, reading: null },
		correctMeaning: meaning,
		distractors: ['the cat', 'the bread', 'the house'],
		itemIds: [itemId],
		explanation: null
	};
}

function translate(itemId: string, promptNative: string, answer = 'el perro') {
	return {
		type: 'translate-to-target',
		promptNative,
		answers: [{ text: answer, reading: null }],
		itemIds: [itemId]
	};
}

const cloze = {
	type: 'cloze',
	before: { text: 'Yo ', reading: null },
	answer: { text: 'leo', reading: null },
	after: { text: ' un libro.', reading: null },
	hintNative: 'I read a book.',
	distractorWords: [
		{ text: 'como', reading: null },
		{ text: 'bebo', reading: null },
		{ text: 'corro', reading: null }
	],
	itemIds: ['new:0'],
	explanation: 'leer -> leo in the first person.'
};

const produce = {
	type: 'produce-mc',
	promptNative: 'early',
	correct: { text: 'temprano', reading: null },
	distractors: [
		{ text: 'tarde', reading: null },
		{ text: 'ahora', reading: null },
		{ text: 'pronto', reading: null }
	],
	instruction: null,
	itemIds: ['new:1'],
	explanation: null
};

const goodBatch = {
	challenges: [
		recognize('i1', 'el perro'),
		translate('i1', 'the dog'),
		recognize('i2', 'leer', 'to read'),
		cloze,
		translate('new:0', 'to read', 'leer'),
		produce
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
	newId: idFactory(),
	rng: IDENTITY_RNG
});

function idFactory(): () => string {
	let n = 0;
	return () => `id-${++n}`;
}

/** parse + resolve, the pairing every caller of this layer uses. */
function resolve(batch: { challenges: unknown[]; newItems?: unknown[] }, opts: ResolveOptions = {}) {
	return resolveBatch(parseBatch(JSON.stringify({ newItems: [], ...batch })), {
		newId: idFactory(),
		now: () => 0,
		rng: IDENTITY_RNG,
		...opts
	});
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
		for (const type of [
			'recognize-mc',
			'produce-mc',
			'cloze',
			'translate-to-target',
			'translate-to-native',
			'word-order',
			'spot-error'
		]) {
			expect(system).toContain(type);
		}
		expect(system).not.toContain('match-pairs');
		expect(system).toContain('new:<index>');
	});

	it('spells out the segmentation and answerability rules for the tile types', () => {
		const system = messages[0].content;
		// One tile per word is the rule that makes these types work for Chinese at
		// all; a per-character split would turn word order into calligraphy.
		expect(system).toContain('one tile per WORD');
		expect(system).toContain('菜单 is one tile');
		// Answerability, per type: one right order, one unambiguously wrong word.
		expect(system).toContain('exactly one natural order');
		expect(system).toContain('unambiguously wrong');
		// The shuffle and the corruption are the app's, and the prompt says so.
		expect(system).toContain('the app shuffles the tiles');
		expect(system).toContain('the app replaces words[wrongPosition]');
	});

	it('never mentions the presentation the app assembles for itself', () => {
		const system = messages[0].content;
		// Direction, option order and blank placement are not the model's to get
		// wrong; asking for them is what used to produce slot-A bias and spoilers.
		expect(system).not.toContain('correctIndex');
		expect(system).not.toContain('"direction"');
		expect(system).not.toContain('promptRomanization');
		expect(system).not.toContain('optionsRomanization');
		expect(system).not.toContain('sentenceRomanization');
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

	it('includes the known-vocabulary terms when supplied — terms only, never the ids', () => {
		// Without it the model re-proposes words the learner already has, and the
		// dedupe silently eats the batch's new-word slots. The ids stay local:
		// they exist for the resolver's term index, not for the prompt.
		const known = [
			{ id: 'k1', term: '名字' },
			{ id: 'k2', term: '做饭' },
			{ id: 'k3', term: '点菜' }
		];
		const content = buildBatchPrompt({ ...args, knownItems: known })[1].content;
		const payload = JSON.parse(content) as Record<string, unknown>;
		expect(payload.known).toEqual(['名字', '做饭', '点菜']);
		expect(content).not.toContain('k1');

		expect(JSON.parse(messages[1].content)).not.toHaveProperty('known');
		expect(
			JSON.parse(buildBatchPrompt({ ...args, knownItems: [] })[1].content)
		).not.toHaveProperty('known');
	});

	it('states the difficulty-calibration rules in the system message', () => {
		const system = messages[0].content;
		expect(system).toContain('recentAccuracy');
		expect(system).toContain('recentMistakes');
		expect(system).toContain('0.7');
		expect(system).toContain('0.85');
		expect(system).toContain('distractorWords');
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

	it("sends the learner's self-description when they wrote one", () => {
		const withAbout = buildBatchPrompt({
			...args,
			profile: { ...args.profile, about: 'Nurse in Valencia, two kids, I climb on weekends.' }
		});
		const payload = JSON.parse(withAbout[1].content) as Record<string, unknown>;
		expect(payload.about).toBe('Nurse in Valencia, two kids, I climb on weekends.');
	});

	it('omits about when it is absent or blank', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('about');
		const blank = buildBatchPrompt({ ...args, profile: { ...args.profile, about: '  \n ' } });
		expect(JSON.parse(blank[1].content)).not.toHaveProperty('about');
	});

	it('caps about, so the token budget never depends on how much they typed', () => {
		const essay = 'x'.repeat(1000);
		const payload = JSON.parse(
			buildBatchPrompt({ ...args, profile: { ...args.profile, about: essay } })[1].content
		) as Record<string, unknown>;
		expect(payload.about).toHaveLength(MAX_ABOUT_CHARS);
		expect(payload.about).toBe('x'.repeat(MAX_ABOUT_CHARS));
	});

	it('tells the model what about is for', () => {
		expect(messages[0].content).toContain('"about"');
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
		// One rule for readings, everywhere, instead of a per-field table.
		expect(system).toContain('TargetText');
		expect(system).toContain('pinyin');
		expect(system).toContain('"reading" is ALWAYS null when the target language');
		// The rule that keeps grading local and free for non-Latin scripts.
		expect(system).toContain('the app derives those from "reading"');
	});

	it('explains that the app, not the model, places the cloze blank', () => {
		const system = messages[0].content;
		expect(system).toContain('the app puts the blank between them');
		expect(system).toContain('before and after carry their own spacing and punctuation');
		// Shown, not just told.
		expect(system).toContain('Nǐ hǎo, qǐng gěi wǒ yī fèn');
	});

	it('demands challenges that are answerable from what is shown', () => {
		const system = messages[0].content;
		// The user's complaint: "where is the fish stall?" with an answer only the
		// model could know.
		expect(system).toContain('Answerable from what is shown alone');
		expect(system).toContain('uniquely determine the answer');
		expect(system).toMatch(/facts you never state/i);
		expect(system).toContain("Say: 'the fish stall is to the right'");
		expect(system).toContain('Exactly one of the four may be correct');
	});

	it('lets the model choose the multiple-choice instruction heading', () => {
		const system = messages[0].content;
		expect(system).toContain('instruction');
		expect(system).toContain('Pick the best reply');
		expect(system).toContain('default meaning-question heading fits');
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

	it('derives direction from the challenge type', async () => {
		const scripted = scriptedFetch([JSON.stringify(goodBatch)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		// recognize-mc, translate-to-target, recognize-mc, cloze, translate, produce-mc
		expect(result.challenges.map((c) => c.direction)).toEqual([
			'toNative',
			'toTarget',
			'toNative',
			'toTarget',
			'toTarget',
			'toTarget'
		]);
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
				{ type: 'recognize-mc', shown: { text: 'x' }, distractors: ['a', 'b'] }
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
			challenges: [...goodBatch.challenges, recognize('i-does-not-exist', 'ghost')]
		};
		const scripted = scriptedFetch([JSON.stringify(hallucinated)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		expect(result.challenges).toHaveLength(6);
	});

	it('honours itemIds cited by term — known words and review items alike', async () => {
		// Known words travel to the model as bare terms with no ids at all, so a
		// challenge built on one can only cite the word itself. Dropping those as
		// "hallucinated" is what made whole batches come back unusable.
		const byTerm = {
			...goodBatch,
			challenges: [
				...goodBatch.challenges,
				recognize('做饭', 'to cook'), // a known word, cited the only way it can be
				recognize(' El Perro ', 'the dog') // a review item cited by term, sloppily
			]
		};
		const scripted = scriptedFetch([JSON.stringify(byTerm)]);
		const result = await generateBatch(
			{ ...args, knownItems: [{ id: 'k9', term: '做饭' }] },
			callOpts(scripted.fetchFn)
		);

		expect(result.challenges).toHaveLength(8);
		const resolved = result.challenges.slice(-2);
		expect(resolved[0].itemIds).toEqual(['k9']);
		expect(resolved[1].itemIds).toEqual(['i1']);
	});

	it('retries once with a corrective instruction, then succeeds', async () => {
		const thin = { challenges: [recognize('i1', 'el perro')], newItems: [] };
		const scripted = scriptedFetch([JSON.stringify(thin), JSON.stringify(goodBatch)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(scripted.calls).toBe(2);
		expect(result.challenges).toHaveLength(6);
		// Usage is summed across both attempts.
		expect(result.usage).toEqual({ promptTokens: 1200, completionTokens: 1800 });
	});

	it('throws bad-response after the retry also fails', async () => {
		const scripted = scriptedFetch(['not json at all', 'still not json']);
		const error = await generateBatch(args, callOpts(scripted.fetchFn)).catch((e: unknown) => e);

		expect(scripted.calls).toBe(2);
		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('bad-response');
	});

	it('throws bad-response when too few challenges survive twice', async () => {
		const thin = JSON.stringify({ challenges: [recognize('i1', 'el perro')], newItems: [] });
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
		const thin = { challenges: [recognize('i1', 'el perro')], newItems: [] };
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
		const tiny = JSON.stringify({ challenges: [recognize('i1', 'el perro')], newItems: [] });
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
		const resolved = resolve({
			challenges: [recognize('new:0', 'x')],
			newItems: [
				{ term: 'a', meaning: 'A' },
				{ term: 'b', meaning: 'B' }
			]
		});
		expect(resolved.newItems).toHaveLength(1);
		expect(resolved.newItems[0].term).toBe('a');
		expect(resolved.challenges[0].itemIds).toEqual([resolved.newItems[0].id]);
	});

	it('drops a challenge whose every reference is unresolvable', () => {
		const resolved = resolve({ challenges: [recognize('new:9', 'x')] });
		expect(resolved.challenges).toHaveLength(0);
		expect(resolved.dropped).toBe(1);
	});

	it('counts malformed entries as dropped rather than failing', () => {
		const parsed = parseBatch(
			JSON.stringify({ challenges: [recognize('i1', 'ok'), { type: 'cloze' }], newItems: [{}] })
		);
		expect(parsed.challenges).toHaveLength(1);
		expect(parsed.dropped).toBe(2);
	});

	it('rejects a completion whose envelope is the wrong shape', () => {
		expect(() => parseBatch('{"challenges":"nope"}')).toThrow(LlmError);
	});

	it('leaves romanization keys off entirely for a Latin-script batch', () => {
		expect(JSON.stringify(resolve(goodBatch))).not.toContain('omanization');
	});

	describe('choice assembly', () => {
		it('shuffles the options and points correctIndex at the right one', () => {
			const resolved = resolve({ challenges: [recognize('i1', 'el perro')] }, { rng: ZERO_RNG });
			const [challenge] = resolved.challenges;
			if (challenge.type !== 'multiple-choice') throw new Error('expected multiple-choice');

			// With rng 0 the correct answer lands last — the point being that the
			// model never got to say where it goes.
			expect(challenge.correctIndex).toBe(3);
			expect(challenge.options[challenge.correctIndex]).toBe('the dog');
			expect([...challenge.options].sort()).toEqual(
				['the dog', 'the cat', 'the bread', 'the house'].sort()
			);
		});

		it('always indexes the correct option, whatever the shuffle does', () => {
			for (let seed = 0; seed < 20; seed++) {
				const resolved = resolve(
					{ challenges: [recognize('i1', 'el perro')] },
					{ rng: () => seed / 20 }
				);
				const [challenge] = resolved.challenges;
				expect(challenge.type === 'multiple-choice' && challenge.options[challenge.correctIndex])
					.toBe('the dog');
			}
		});

		it('reads a recognize-mc target prompt but never annotates its native options', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'recognize-mc',
						shown: { text: '菜单', reading: 'càidān' },
						correctMeaning: 'the menu',
						distractors: ['the bill', 'the chopsticks', 'the waiter'],
						itemIds: ['i1']
					}
				]
			});
			const [challenge] = resolved.challenges;
			if (challenge.type !== 'multiple-choice') throw new Error('expected multiple-choice');
			expect(challenge.prompt).toBe('菜单');
			expect(challenge.promptRomanization).toBe('càidān');
			expect('optionsRomanization' in challenge).toBe(false);
			expect(challenge.direction).toBe('toNative');
		});

		it('aligns optionsRomanization with the shuffle when every option has a reading', () => {
			const zh = (text: string, reading: string | null) => ({ text, reading });
			const resolved = resolve(
				{
					challenges: [
						{
							type: 'produce-mc',
							promptNative: 'the menu',
							correct: zh('菜单', 'càidān'),
							distractors: [zh('筷子', 'kuàizi'), zh('服务员', 'fúwùyuán'), zh('茶', 'chá')],
							itemIds: ['i1']
						}
					]
				},
				{ rng: ZERO_RNG }
			);
			const [challenge] = resolved.challenges;
			if (challenge.type !== 'multiple-choice') throw new Error('expected multiple-choice');

			const readings: Record<string, string> = {
				菜单: 'càidān',
				筷子: 'kuàizi',
				服务员: 'fúwùyuán',
				茶: 'chá'
			};
			expect(challenge.optionsRomanization).toEqual(
				challenge.options.map((option) => readings[option])
			);
			expect(challenge.options[challenge.correctIndex]).toBe('菜单');
			// The prompt is native; the field does not exist for it to spoil.
			expect('promptRomanization' in challenge).toBe(false);
			expect(challenge.direction).toBe('toTarget');
		});

		it('drops optionsRomanization entirely when one reading is missing', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'produce-mc',
						promptNative: 'the menu',
						correct: { text: '菜单', reading: 'càidān' },
						distractors: [
							{ text: '筷子', reading: 'kuàizi' },
							{ text: '服务员', reading: '   ' },
							{ text: '茶', reading: 'chá' }
						],
						itemIds: ['i1']
					}
				]
			});
			// A half-annotated column is worse than none; the challenge survives.
			expect(resolved.challenges).toHaveLength(1);
			expect(resolved.challenges[0]).not.toHaveProperty('optionsRomanization');
		});

		it('copies a multiple-choice instruction, omitting it when null', () => {
			const resolved = resolve({
				challenges: [
					{ ...recognize('i1', 'el perro'), instruction: 'Pick the best reply' },
					{ ...recognize('i2', 'leer', 'to read'), instruction: null }
				]
			});
			const [withInstruction, withoutInstruction] = resolved.challenges;

			expect(
				withInstruction.type === 'multiple-choice' ? withInstruction.instruction : undefined
			).toBe('Pick the best reply');
			expect(
				withoutInstruction.type === 'multiple-choice' && 'instruction' in withoutInstruction
			).toBe(false);

			for (const challenge of resolved.challenges) {
				expect(challengeSchema.safeParse(challenge).success).toBe(true);
			}
		});
	});

	describe('cloze assembly', () => {
		const zhCloze = {
			type: 'cloze',
			before: { text: '你好，请给我一份', reading: 'Nǐ hǎo, qǐng gěi wǒ yī fèn' },
			answer: { text: '菜单', reading: 'càidān' },
			after: { text: '。', reading: '.' },
			hintNative: 'Hello, could I have a menu, please?',
			distractorWords: [
				{ text: '筷子', reading: 'kuàizi' },
				{ text: '茶', reading: 'chá' },
				{ text: '水', reading: 'shuǐ' }
			],
			itemIds: ['i1']
		};

		function resolveCloze(overrides: Record<string, unknown> = {}, opts: ResolveOptions = {}) {
			const resolved = resolve({ challenges: [{ ...zhCloze, ...overrides }] }, opts);
			const [challenge] = resolved.challenges;
			return challenge?.type === 'cloze' ? challenge : undefined;
		}

		it('puts exactly one blank between the two halves, verbatim', () => {
			const challenge = resolveCloze();
			expect(challenge?.sentence).toBe('你好，请给我一份___。');
			expect(challenge?.sentence.split('___')).toHaveLength(2);
			expect(challenge?.direction).toBe('toTarget');
			expect(challenge?.translationHint).toBe('Hello, could I have a menu, please?');
		});

		it('romanizes around the blank and structurally cannot leak the answer', () => {
			const challenge = resolveCloze();
			expect(challenge?.sentenceRomanization).toBe('Nǐ hǎo, qǐng gěi wǒ yī fèn ___.');
			expect(challenge?.sentenceRomanization).toContain('___');
			// The answer's reading lives in its own field and is never concatenated.
			expect(challenge?.sentenceRomanization).not.toContain('càidān');
			expect(challenge?.sentenceRomanization).not.toContain('caidan');
		});

		it('accepts the answer typed in script, in pinyin, or without the tones', () => {
			const challenge = resolveCloze();
			expect(challenge?.acceptedAnswers).toEqual(['菜单', 'càidān', 'caidan']);
		});

		it('carries the answer its own reading, for the post-answer feedback', () => {
			const challenge = resolveCloze();
			// The reading of acceptedAnswers[0], and of nothing else.
			expect(challenge?.answerRomanization).toBe('càidān');
			expect(challenge?.acceptedAnswers[0]).toBe('菜单');
		});

		it('omits answerRomanization when the answer has no reading', () => {
			const challenge = resolveCloze({ answer: { text: '菜单', reading: null } });
			expect('answerRomanization' in (challenge ?? {})).toBe(false);
		});

		it('shuffles the answer into the word bank and reads every chip', () => {
			const challenge = resolveCloze({}, { rng: ZERO_RNG });
			expect(challenge?.wordBank).toContain('菜单');
			expect(challenge?.wordBank).toHaveLength(4);
			expect(challenge?.wordBankRomanization).toHaveLength(4);
			const readings: Record<string, string> = {
				菜单: 'càidān',
				筷子: 'kuàizi',
				茶: 'chá',
				水: 'shuǐ'
			};
			expect(challenge?.wordBankRomanization).toEqual(
				challenge?.wordBank?.map((word) => readings[word])
			);
		});

		it('omits wordBankRomanization when one chip has no reading', () => {
			const challenge = resolveCloze({
				distractorWords: [
					{ text: '筷子', reading: 'kuàizi' },
					{ text: '茶', reading: null },
					{ text: '水', reading: 'shuǐ' }
				]
			});
			expect(challenge?.wordBank).toHaveLength(4);
			expect('wordBankRomanization' in (challenge ?? {})).toBe(false);
		});

		it('drops distractors that duplicate the answer, and the bank with them', () => {
			const challenge = resolveCloze({
				distractorWords: [
					{ text: ' 菜单 ', reading: 'càidān' },
					{ text: '菜单', reading: 'càidān' }
				]
			});
			// One chip is not a choice: fall back to typing.
			expect('wordBank' in (challenge ?? {})).toBe(false);
			expect(challenge?.acceptedAnswers).toContain('菜单');
		});

		it('keeps a two-chip bank once duplicates are gone', () => {
			const challenge = resolveCloze({
				distractorWords: [
					{ text: '茶', reading: 'chá' },
					{ text: '茶', reading: 'chá' }
				]
			});
			expect(challenge?.wordBank?.length).toBe(2);
			expect(challenge?.wordBank).toContain('菜单');
		});

		it('has no word bank at all when the model sent no distractors', () => {
			const challenge = resolveCloze({ distractorWords: null });
			expect('wordBank' in (challenge ?? {})).toBe(false);
			expect('wordBankRomanization' in (challenge ?? {})).toBe(false);
		});

		it('handles a sentence that opens or closes on the blank', () => {
			const leading = resolveCloze({
				before: { text: '', reading: null },
				after: { text: '，请给我菜单。', reading: ', qǐng gěi wǒ càidān.' },
				answer: { text: '你好', reading: 'nǐ hǎo' }
			});
			expect(leading?.sentence).toBe('___，请给我菜单。');
			expect(leading?.sentenceRomanization).toBe('___, qǐng gěi wǒ càidān.');

			const trailing = resolveCloze({
				after: { text: '', reading: null }
			});
			expect(trailing?.sentence).toBe('你好，请给我一份___');
			expect(trailing?.sentenceRomanization).toBe('Nǐ hǎo, qǐng gěi wǒ yī fèn ___');
		});

		it('drops the reading when a visible half has none', () => {
			const challenge = resolveCloze({ after: { text: '。', reading: '  ' } });
			expect(challenge).toBeDefined();
			expect('sentenceRomanization' in (challenge ?? {})).toBe(false);
			expect(challenge?.sentence).toBe('你好，请给我一份___。');
		});

		it('adds no reading for a Latin-script cloze', () => {
			const resolved = resolve({
				challenges: [cloze],
				newItems: [{ term: 'leer', meaning: 'to read' }]
			});
			const [challenge] = resolved.challenges;
			if (challenge.type !== 'cloze') throw new Error('expected cloze');
			expect(challenge.sentence).toBe('Yo ___ un libro.');
			expect('sentenceRomanization' in challenge).toBe(false);
			expect('answerRomanization' in challenge).toBe(false);
			expect(challenge.acceptedAnswers).toEqual(['leo']);
			expect(challenge.wordBank).toHaveLength(4);
			expect('wordBankRomanization' in challenge).toBe(false);
		});
	});

	describe('typed translation', () => {
		it('carries no promptRomanization key toTarget: the prompt is native', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'translate-to-target',
						promptNative: 'Excuse me, the bill please.',
						answers: [
							{ text: '服务员，买单', reading: 'fúwùyuán, mǎidān' },
							{ text: '买单', reading: 'mǎidān' }
						],
						itemIds: ['i1']
					}
				]
			});
			const [challenge] = resolved.challenges;
			if (challenge.type !== 'typed-translation') throw new Error('expected typed-translation');

			expect('promptRomanization' in challenge).toBe(false);
			// The canonical answer's own reading, for the banner to show afterwards.
			expect(challenge.answerRomanization).toBe('fúwùyuán, mǎidān');
			expect(challenge.direction).toBe('toTarget');
			// Toneless variants are derived, not asked for.
			expect(challenge.acceptedAnswers).toEqual([
				'服务员，买单',
				'fúwùyuán, mǎidān',
				'fuwuyuan, maidan',
				'买单',
				'mǎidān',
				'maidan'
			]);
		});

		it('derives accent-stripped variants for a Latin-script target too', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'translate-to-target',
						promptNative: 'the water is cold',
						answers: [{ text: 'el agua está fría', reading: null }],
						itemIds: ['i1']
					}
				]
			});
			const [challenge] = resolved.challenges;
			expect(challenge.type === 'typed-translation' && challenge.acceptedAnswers).toEqual([
				'el agua está fría',
				'el agua esta fria'
			]);
			// A Latin script needs no reading, so no key is written at all.
			expect(challenge).not.toHaveProperty('answerRomanization');
		});

		it('reads the prompt toNative and takes the native answers as given', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'translate-to-native',
						prompt: { text: '买单', reading: 'mǎidān' },
						answersNative: ['to pay the bill', 'pay the bill', 'to pay the bill'],
						itemIds: ['i1']
					}
				]
			});
			const [challenge] = resolved.challenges;
			if (challenge.type !== 'typed-translation') throw new Error('expected typed-translation');

			expect(challenge.direction).toBe('toNative');
			expect(challenge.prompt).toBe('买单');
			expect(challenge.promptRomanization).toBe('mǎidān');
			expect(challenge.acceptedAnswers).toEqual(['to pay the bill', 'pay the bill']);
			// The answer is the learner's own language; there is nothing to read.
			expect('answerRomanization' in challenge).toBe(false);
		});

		it('omits promptRomanization toNative for a Latin-script target', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'translate-to-native',
						prompt: { text: 'la cuenta', reading: null },
						answersNative: ['the bill'],
						itemIds: ['i1']
					}
				]
			});
			expect(resolved.challenges[0]).not.toHaveProperty('promptRomanization');
		});
	});

	describe('word-order assembly', () => {
		const wordOrder = {
			type: 'word-order',
			promptNative: 'I read a book.',
			words: [
				{ text: 'Yo', reading: null },
				{ text: 'leo', reading: null },
				{ text: 'un', reading: null },
				{ text: 'libro.', reading: null }
			],
			distractorWords: [{ text: 'bebo', reading: null }],
			itemIds: ['i1']
		};

		function resolveWordOrder(overrides: Record<string, unknown> = {}, opts: ResolveOptions = {}) {
			const resolved = resolve({ challenges: [{ ...wordOrder, ...overrides }] }, opts);
			const [challenge] = resolved.challenges;
			return challenge?.type === 'word-order' ? challenge : undefined;
		}

		it('keeps the model order as the answer and shuffles what is shown', () => {
			const challenge = resolveWordOrder({}, { rng: ZERO_RNG });
			expect(challenge?.answerTokens).toEqual(['Yo', 'leo', 'un', 'libro.']);
			expect(challenge?.answer).toBe('Yo leo un libro.');
			expect(challenge?.direction).toBe('toTarget');
			// Five tiles: four real plus the distractor, in an order the model
			// never got to choose.
			expect(challenge?.tiles).toHaveLength(5);
			expect([...(challenge?.tiles ?? [])].sort()).toEqual(
				['Yo', 'leo', 'un', 'libro.', 'bebo'].sort()
			);
			expect(challenge?.tiles).not.toEqual(challenge?.answerTokens);
		});

		it('joins a no-space script without spaces, and its readings with them', () => {
			const challenge = resolveWordOrder({
				words: [
					{ text: '我们', reading: 'wǒmen' },
					{ text: '想', reading: 'xiǎng' },
					{ text: '买单', reading: 'mǎidān' }
				],
				distractorWords: null
			});
			expect(challenge?.answer).toBe('我们想买单');
			expect(challenge?.answerRomanization).toBe('wǒmen xiǎng mǎidān');
			expect(challenge?.tilesRomanization).toHaveLength(3);
		});

		it('drops a partial romanization rather than a challenge', () => {
			const challenge = resolveWordOrder({
				words: [
					{ text: '我们', reading: 'wǒmen' },
					{ text: '想', reading: '  ' },
					{ text: '买单', reading: 'mǎidān' }
				],
				distractorWords: null
			});
			expect(challenge).toBeDefined();
			expect(challenge).not.toHaveProperty('tilesRomanization');
			expect(challenge).not.toHaveProperty('answerRomanization');
		});

		it('caps an oversized distractor list instead of dropping the challenge', () => {
			const challenge = resolveWordOrder({
				distractorWords: ['bebo', 'como', 'corro', 'salto', 'canto', 'duermo'].map((text) => ({
					text,
					reading: null
				}))
			});
			// Four real tiles plus MAX_WORD_ORDER_DISTRACTORS.
			expect(challenge?.tiles).toHaveLength(4 + MAX_WORD_ORDER_DISTRACTORS);
		});

		it('drops a distractor that duplicates a real tile: it could never be wrong', () => {
			const challenge = resolveWordOrder({
				distractorWords: [
					{ text: 'leo', reading: null },
					{ text: 'bebo', reading: null }
				]
			});
			expect(challenge?.tiles).toHaveLength(5);
			expect(challenge?.tiles.filter((tile) => tile === 'leo')).toHaveLength(1);
		});

		it('keeps a sentence that legitimately repeats a word', () => {
			// Duplicate *answer* tokens are fine — grading is by text sequence, not
			// by which tile the learner happened to tap.
			const challenge = resolveWordOrder({
				words: [
					{ text: 'Ni', reading: null },
					{ text: 'leo', reading: null },
					{ text: 'ni', reading: null },
					{ text: 'escribo.', reading: null }
				],
				distractorWords: null
			});
			expect(challenge?.answerTokens).toEqual(['Ni', 'leo', 'ni', 'escribo.']);
			expect(challenge?.tiles).toHaveLength(4);
		});

		it('drops the challenge when there is no sentence to build', () => {
			const resolved = resolve({
				challenges: [{ ...wordOrder, words: [{ text: 'Yo', reading: null }] }]
			});
			// Rejected by the schema before it ever reaches the resolver.
			expect(resolved.challenges).toHaveLength(0);

			const blank = resolve({
				challenges: [
					{
						...wordOrder,
						words: [
							{ text: '   ', reading: null },
							{ text: 'leo', reading: null }
						]
					}
				]
			});
			expect(blank.challenges).toHaveLength(0);
			expect(blank.dropped).toBe(1);
		});

		it('copies an instruction, omitting it when null', () => {
			expect(resolveWordOrder({ instruction: 'Build the sentence' })?.instruction).toBe(
				'Build the sentence'
			);
			expect(resolveWordOrder({ instruction: null })).not.toHaveProperty('instruction');
		});
	});

	describe('spot-error assembly', () => {
		const spotError = {
			type: 'spot-error',
			words: [
				{ text: '我们', reading: 'wǒmen' },
				{ text: '想', reading: 'xiǎng' },
				{ text: '买单', reading: 'mǎidān' }
			],
			wrongWord: { text: '菜单', reading: 'càidān' },
			wrongPosition: 2,
			meaningNative: 'We would like to pay the bill.',
			itemIds: ['i1']
		};

		function resolveSpotError(overrides: Record<string, unknown> = {}) {
			const resolved = resolve({ challenges: [{ ...spotError, ...overrides }] });
			const [challenge] = resolved.challenges;
			return challenge?.type === 'spot-error' ? challenge : undefined;
		}

		it('applies the corruption at the stated position and nowhere else', () => {
			const challenge = resolveSpotError();
			expect(challenge?.tokens).toEqual(['我们', '想', '菜单']);
			expect(challenge?.correctIndex).toBe(2);
			expect(challenge?.intendedWord).toBe('买单');
			expect(challenge?.correctedSentence).toBe('我们想买单');
			expect(challenge?.meaning).toBe('We would like to pay the bill.');
			expect(challenge?.direction).toBe('toNative');
		});

		it('reads every token, the wrong one included, and the word that belonged', () => {
			const challenge = resolveSpotError();
			expect(challenge?.tokensRomanization).toEqual(['wǒmen', 'xiǎng', 'càidān']);
			expect(challenge?.intendedWordRomanization).toBe('mǎidān');
		});

		it('drops a partial romanization rather than the challenge', () => {
			const challenge = resolveSpotError({ wrongWord: { text: '菜单', reading: null } });
			expect(challenge).toBeDefined();
			expect(challenge).not.toHaveProperty('tokensRomanization');
			// The intended word still has its own reading; only the row is all-or-nothing.
			expect(challenge?.intendedWordRomanization).toBe('mǎidān');
		});

		it('drops a wrongPosition that overshoots the sentence', () => {
			const resolved = resolve({ challenges: [{ ...spotError, wrongPosition: 3 }] });
			expect(resolved.challenges).toHaveLength(0);
			expect(resolved.dropped).toBe(1);
		});

		it('drops a wrongWord that is the word it replaces', () => {
			const resolved = resolve({
				challenges: [{ ...spotError, wrongWord: { text: ' 买单 ', reading: 'mǎidān' } }]
			});
			expect(resolved.challenges).toHaveLength(0);
			expect(resolved.dropped).toBe(1);
		});

		it('spaces a Latin sentence back together', () => {
			const challenge = resolveSpotError({
				words: [
					{ text: 'Quisiera', reading: null },
					{ text: 'pedir', reading: null },
					{ text: 'el', reading: null },
					{ text: 'pescado.', reading: null }
				],
				wrongWord: { text: 'pagar', reading: null },
				wrongPosition: 1,
				meaningNative: 'I would like to order the fish.'
			});
			expect(challenge?.tokens).toEqual(['Quisiera', 'pagar', 'el', 'pescado.']);
			expect(challenge?.correctedSentence).toBe('Quisiera pedir el pescado.');
			expect(challenge).not.toHaveProperty('tokensRomanization');
		});
	});

	it('emits only valid domain challenges for a mixed batch', () => {
		const resolved = resolve(goodBatch);
		expect(resolved.challenges).toHaveLength(6);
		for (const challenge of resolved.challenges) {
			expect(challengeSchema.safeParse(challenge).success).toBe(true);
		}
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
