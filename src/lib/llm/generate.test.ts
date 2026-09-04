import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '$lib/types';
import type { FetchLike } from './client';
import { LlmError } from './client';
import {
	MAX_ABOUT_CHARS,
	MAX_BATCH_CHALLENGES,
	MAX_WORD_ORDER_DISTRACTORS,
	MAX_WORD_ORDER_TILES,
	buildChunkPrompt,
	defaultChallengeCount,
	generateBatch,
	knownTermIndex,
	knownTermLabels,
	makeMatchPairsChallenge,
	parseBatch,
	resolveBatch,
	stripFences
} from './generate';
import type { BatchArgs, ProgressStep, ResolveOptions } from './generate';
import { byType } from './challenge-types';
import type { WireType } from './challenge-types';
import { challengeSchema } from './schemas';
import { CHUNK_CONCURRENCY, CHUNK_ITEMS, CHUNK_SLOTS, chunkSlots, planSlots } from './slots';

/**
 * Two solid words, so the plan a lesson gets is a mix of recognition and
 * production types rather than four ways of recognizing — the generation tests
 * answer the plan they are given, so a richer plan tests more of the pipeline.
 */
const args: BatchArgs = {
	profile: {
		nativeLanguage: 'English',
		targetLanguage: 'Spanish',
		level: 'beginner',
		interests: ['cooking', 'cycling']
	},
	reviewItems: [
		{ id: 'i1', term: 'el perro', meaning: 'the dog', level: 5 },
		{ id: 'i2', term: 'leer', meaning: 'to read', level: 5 }
	]
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
	itemIds: ['i2'],
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
	itemIds: ['i2'],
	explanation: null
};

const goodBatch = {
	challenges: [
		recognize('i1', 'el perro'),
		translate('i1', 'the dog'),
		recognize('i2', 'leer', 'to read'),
		cloze,
		translate('i2', 'to read', 'leer'),
		produce
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
	newId: idFactory(),
	rng: IDENTITY_RNG
});

function idFactory(): () => string {
	let n = 0;
	return () => `id-${++n}`;
}

/** A planned slot, as `planSlots` returns it and as the chunk payload spells it. */
interface SlotLike {
	itemId: string;
	type: string;
	bank?: boolean;
}

/**
 * The wire challenge a well-behaved model writes for one slot: that wire type's
 * own Spanish fixture, re-pointed at the slot's word and stamped in
 * `explanation` with the slot it fills.
 *
 * Using the registry's fixtures rather than a hand-rolled recognize-mc is what
 * makes these tests exercise every type end to end — the plan decides which
 * types a lesson asks for, and the reply now has to answer in *those* types or
 * be rejected.
 */
function fillSlot(slot: SlotLike): Record<string, unknown> {
	const def = byType.get(slot.type as WireType);
	if (!def) throw new Error(`no wire def for ${slot.type}`);
	const fixtures = def.fixtures.spanish as unknown as readonly {
		challenge: Record<string, unknown>;
	}[];
	const wanted =
		slot.bank === undefined
			? fixtures[0]
			: (fixtures.find((f) => (f.challenge.distractorWords != null) === slot.bank) ?? fixtures[0]);
	return {
		...wanted.challenge,
		itemIds: [slot.itemId],
		explanation: `${slot.itemId}-${slot.type}`
	};
}

/** The reply that fills a whole plan (or one chunk of it), in slot order. */
function fillPlan(slots: readonly SlotLike[]): { challenges: Record<string, unknown>[] } {
	return { challenges: slots.map(fillSlot) };
}

/**
 * The lesson `args` plans under the `rng` {@link callOpts} passes, in the order
 * the chunks ask for it (a word's slots travel together), and the reply that
 * fills it.
 */
const plan = chunkSlots(planSlots(args, IDENTITY_RNG), args.reviewItems).flatMap((c) => c.slots);
const plannedReply = fillPlan(plan);

/** The first slot of the plan about this word — where a term-citation test lands. */
const slotAbout = (itemId: string): number => plan.findIndex((slot) => slot.itemId === itemId);

/** parse + resolve, the pairing every caller of this layer uses. */
function resolve(batch: { challenges: unknown[] }, opts: ResolveOptions = {}) {
	return resolveBatch(parseBatch(JSON.stringify(batch)), {
		newId: idFactory(),
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

/**
 * The messages for a lesson's first chunk. Everything the prompt tests care
 * about — the static system half, the profile, `known`, the calibration dials —
 * is on every chunk, so the first one is a fair witness for all of them.
 */
function firstChunkPrompt(batchArgs: BatchArgs = args) {
	const chunks = chunkSlots(planSlots(batchArgs, ZERO_RNG), batchArgs.reviewItems);
	return buildChunkPrompt(batchArgs, chunks[0]);
}

describe('buildChunkPrompt', () => {
	const messages = firstChunkPrompt();

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
		// A batch has no vocabulary of its own to point at, so the only legal
		// references are an id it was given and a term it was shown.
		expect(system).not.toContain('new:<index>');
		expect(system).not.toContain('newItems');
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
		expect(payload).not.toHaveProperty('newItemSlots');
		expect(payload.reviewItems).toEqual([
			{ id: 'i1', t: 'el perro', m: 'the dog' },
			{ id: 'i2', t: 'leer', m: 'to read' }
		]);
		expect(payload.recentMistakes).toBeUndefined();
	});

	it('lists the slots to fill, and nothing about how they were chosen', () => {
		const payload = JSON.parse(messages[1].content) as {
			slots: { item: string; type: string; difficulty: number; bank?: boolean }[];
		};
		expect(payload.slots).toHaveLength(4);
		for (const slot of payload.slots) {
			expect(['i1', 'i2']).toContain(slot.item);
			expect(typeof slot.type).toBe('string');
			expect(slot.difficulty).toBeGreaterThanOrEqual(1);
			expect(slot.difficulty).toBeLessThanOrEqual(5);
			// The bank flag rides only where it means something.
			if (slot.type !== 'cloze') expect(slot).not.toHaveProperty('bank');
		}
		// `level` chose the types; the types are chosen, so it no longer travels —
		// only its already-folded `difficulty` does. (`payload.level` is the
		// learner's proficiency level, e.g. "beginner" — a different field.)
		const withLevel = firstChunkPrompt({
			...args,
			reviewItems: args.reviewItems.map((i) => ({ ...i, level: 5 as const }))
		});
		const withLevelPayload = JSON.parse(withLevel[1].content) as {
			reviewItems: Record<string, unknown>[];
			slots: Record<string, unknown>[];
		};
		for (const reviewItem of withLevelPayload.reviewItems) {
			expect(reviewItem).not.toHaveProperty('level');
		}
		for (const slot of withLevelPayload.slots) {
			expect(slot).not.toHaveProperty('level');
		}
	});

	it('names the word beside the slot, so the brief reads without a lookup', () => {
		const payload = JSON.parse(messages[1].content) as { slots: { item: string; t: string }[] };
		const terms = new Map(args.reviewItems.map((i) => [i.id, i.term]));
		for (const slot of payload.slots) expect(slot.t).toBe(terms.get(slot.item));
	});

	it('writes everything shared across chunks before anything per-chunk', () => {
		// Prompt caching pays up to the first byte that differs. `known` is the
		// biggest block and identical on every chunk of a lesson, so it belongs
		// above the keys that are the whole reason there are several chunks.
		const withKnown = firstChunkPrompt({
			...args,
			topic: 'ordering in a restaurant',
			knownItems: [{ id: 'k1', term: '做饭' }],
			recentMistakes: [{ term: 'leer', gave: 'lees' }]
		});
		const keys = Object.keys(JSON.parse(withKnown[1].content) as Record<string, unknown>);
		const shared = ['native', 'target', 'level', 'topic', 'interests', 'known'];
		const perChunk = ['reviewItems', 'slots', 'recentMistakes'];
		for (const key of [...shared, ...perChunk]) expect(keys).toContain(key);
		expect(Math.max(...shared.map((k) => keys.indexOf(k)))).toBeLessThan(
			Math.min(...perChunk.map((k) => keys.indexOf(k)))
		);
	});

	it('includes recent mistakes for the words this chunk is about', () => {
		const withMistakes = firstChunkPrompt({
			...args,
			recentMistakes: [
				{ term: 'leer', gave: 'lees' },
				// Not a review item of this lesson: nothing in the chunk can be written
				// easier for it, so it is not worth a token.
				{ term: 'temprano', gave: '(skipped)' }
			]
		});
		const payload = JSON.parse(withMistakes[1].content) as Record<string, unknown>;
		expect(payload.recentMistakes).toEqual([{ t: 'leer', gave: 'lees' }]);
	});

	it('never sends recentAccuracy: it only ever fed the difficulty cliffs, now folded locally into difficulty', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('recentAccuracy');
		const withAccuracy = JSON.parse(
			firstChunkPrompt({ ...args, recentAccuracy: 0.95 })[1].content
		) as Record<string, unknown>;
		expect(withAccuracy).not.toHaveProperty('recentAccuracy');
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
		const content = firstChunkPrompt({ ...args, knownItems: known })[1].content;
		const payload = JSON.parse(content) as Record<string, unknown>;
		expect(payload.known).toEqual(['名字', '做饭', '点菜']);
		expect(content).not.toContain('k1');

		expect(JSON.parse(messages[1].content)).not.toHaveProperty('known');
		expect(JSON.parse(firstChunkPrompt({ ...args, knownItems: [] })[1].content)).not.toHaveProperty(
			'known'
		);
	});

	it('qualifies a known term only when the collection holds two of that spelling', () => {
		// A reading costs tokens and buys nothing where the spelling is already
		// unique — which is every word, for nearly every learner.
		const payload = JSON.parse(
			firstChunkPrompt({
				...args,
				knownItems: [
					{ id: 'k1', term: '长', romanization: 'cháng' },
					{ id: 'k2', term: '长', romanization: 'zhǎng' },
					{ id: 'k3', term: '做饭', romanization: 'zuò fàn' }
				]
			})[1].content
		) as Record<string, unknown>;

		expect(payload.known).toEqual(['长 (cháng)', '长 (zhǎng)', '做饭']);
	});

	it('tells the model what a parenthesised reading in known means', () => {
		expect(messages[0].content).toContain('"word (reading)"');
	});

	it('calibrates content off the per-slot difficulty, and leaves type choice out of it', () => {
		const system = messages[0].content;
		// The one shared ladder line replaces the old recentAccuracy cliffs.
		expect(system).toContain('difficulty');
		expect(system).toContain('1-5');
		expect(system).not.toContain('recentAccuracy');
		expect(system).not.toContain('0.7');
		expect(system).not.toContain('0.85');
		expect(system).toContain('recentMistakes');
		// Every type states its own gradient.
		expect(system).toContain('Difficulty scales tile count');
		expect(system).toContain('recognize-mc: difficulty scales');
		// The slot rule replaced the paragraph of type-selection rules.
		expect(system).toContain('one challenge object per slot');
		expect(system).toContain('"bank": true');
		expect(system).not.toContain('Match type to maturity');
		expect(system).not.toContain('Mix recognition and production');
		expect(system).not.toContain('(skipped)');
	});

	it('derives two challenges per word, and caps the count', () => {
		expect(defaultChallengeCount(2)).toBe(4);
		expect(defaultChallengeCount(40)).toBe(MAX_BATCH_CHALLENGES);
	});

	it('threads the session topic into the user message, ahead of interests', () => {
		const withTopic = firstChunkPrompt({ ...args, topic: 'ordering in a restaurant' });
		const raw = withTopic[1].content;
		expect(raw).toContain('ordering in a restaurant');

		const payload = JSON.parse(raw) as Record<string, unknown>;
		expect(payload.topic).toBe('ordering in a restaurant');
		const keys = Object.keys(payload);
		expect(keys.indexOf('topic')).toBeLessThan(keys.indexOf('interests'));
	});

	it("sends the learner's self-description when they wrote one", () => {
		const withAbout = firstChunkPrompt({
			...args,
			profile: { ...args.profile, about: 'Nurse in Valencia, two kids, I climb on weekends.' }
		});
		const payload = JSON.parse(withAbout[1].content) as Record<string, unknown>;
		expect(payload.about).toBe('Nurse in Valencia, two kids, I climb on weekends.');
	});

	it('omits about when it is absent or blank', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('about');
		const blank = firstChunkPrompt({ ...args, profile: { ...args.profile, about: '  \n ' } });
		expect(JSON.parse(blank[1].content)).not.toHaveProperty('about');
	});

	it('caps about, so the token budget never depends on how much they typed', () => {
		const essay = 'x'.repeat(1000);
		const payload = JSON.parse(
			firstChunkPrompt({ ...args, profile: { ...args.profile, about: essay } })[1].content
		) as Record<string, unknown>;
		expect(payload.about).toHaveLength(MAX_ABOUT_CHARS);
		expect(payload.about).toBe('x'.repeat(MAX_ABOUT_CHARS));
	});

	it('tells the model what about is for', () => {
		expect(messages[0].content).toContain('"about"');
	});

	it('omits the topic key entirely when there is none', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('topic');
		const blank = firstChunkPrompt({ ...args, topic: '   ' });
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
	it('assigns ids and returns challenges only, never vocabulary', async () => {
		const scripted = scriptedFetch([JSON.stringify(plannedReply)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(result.challenges).toHaveLength(plan.length);
		expect(result.usage).toEqual({ promptTokens: 600, completionTokens: 900 });
		// The learner's collection is not this layer's to grow — there is nothing
		// in the result for a caller to persist but the pool.
		expect(result).not.toHaveProperty('newItems');

		// Every emitted challenge is a valid domain Challenge.
		for (const challenge of result.challenges) {
			expect(challengeSchema.safeParse(challenge).success).toBe(true);
			expect(challenge.id).toMatch(/^id-\d+$/);
		}

		// Existing ids pass through untouched.
		expect(result.challenges[0].itemIds).toEqual(['i1']);
	});

	it('derives direction from the challenge type', async () => {
		const scripted = scriptedFetch([JSON.stringify(plannedReply)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		// The plan for `args`, in chunk order: both of i1's slots, then both of
		// i2's — each resolving into the direction its wire def declares, never
		// one the model chose.
		expect(plan.map((s) => s.type)).toEqual([
			'spot-error',
			'translate-to-native',
			'cloze',
			'translate-to-target'
		]);
		expect(result.challenges.map((c) => c.direction)).toEqual([
			'toNative',
			'toNative',
			'toTarget',
			'toTarget'
		]);
	});

	it('strips markdown fences around the JSON', async () => {
		const scripted = scriptedFetch(['```json\n' + JSON.stringify(plannedReply) + '\n```']);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		expect(result.challenges).toHaveLength(plan.length);
	});

	it('salvages the batch when a single challenge is malformed', async () => {
		const damaged = {
			challenges: [
				...plannedReply.challenges,
				{ type: 'recognize-mc', shown: { text: 'x' }, distractors: ['a', 'b'] }
			]
		};
		const scripted = scriptedFetch([JSON.stringify(damaged)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(result.challenges).toHaveLength(plan.length);
		expect(scripted.calls).toBe(1);
	});

	it('drops challenges that reference an id the model invented', async () => {
		const hallucinated = {
			challenges: [...plannedReply.challenges, recognize('i-does-not-exist', 'ghost')]
		};
		const scripted = scriptedFetch([JSON.stringify(hallucinated)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));
		expect(result.challenges).toHaveLength(plan.length);
	});

	it('honours itemIds cited by term — known words and review items alike', async () => {
		// Known words travel to the model as bare terms with no ids at all, so a
		// challenge built on one can only cite the word itself. Dropping those as
		// "hallucinated" is what made whole batches come back unusable.
		const first = slotAbout('i1');
		const second = slotAbout('i2');
		const byTermCitation = {
			challenges: plannedReply.challenges.map((challenge, i) =>
				i === first
					? { ...challenge, itemIds: [' El Perro '] } // a review item, cited sloppily by term
					: i === second
						? { ...challenge, itemIds: ['i2', '做饭'] } // plus a known word, the only way it can be cited
						: challenge
			)
		};
		const scripted = scriptedFetch([JSON.stringify(byTermCitation)]);
		const result = await generateBatch(
			{ ...args, knownItems: [{ id: 'k9', term: '做饭' }] },
			callOpts(scripted.fetchFn)
		);

		expect(result.challenges).toHaveLength(plan.length);
		expect(result.challenges[first].itemIds).toEqual(['i1']);
		expect(result.challenges[second].itemIds).toEqual(['i2', 'k9']);
	});

	it('resolves a homograph cited with its reading onto that card, not its sibling', async () => {
		// The whole round trip: the prompt renders `长 (zhǎng)`, the model cites it
		// back, and the resolver puts the review credit on the right of two cards.
		const knownItems = [
			{ id: 'chang', term: '长', romanization: 'cháng' },
			{ id: 'zhang', term: '长', romanization: 'zhǎng' }
		];
		const first = slotAbout('i1');
		const second = slotAbout('i2');
		const cited = {
			challenges: plannedReply.challenges.map((challenge, i) =>
				i === first
					? { ...challenge, itemIds: ['i1', '长 (zhǎng)'] }
					: i === second
						? { ...challenge, itemIds: ['i2', '长'] } // Bare: a coin the app does not flip.
						: challenge
			)
		};
		const scripted = scriptedFetch([JSON.stringify(cited)]);
		const result = await generateBatch({ ...args, knownItems }, callOpts(scripted.fetchFn));

		expect(result.challenges[first].itemIds).toEqual(['i1', 'zhang']);
		expect(result.challenges[second].itemIds).toEqual(['i2', 'chang']);
	});

	it('retries once with a corrective instruction, then succeeds', async () => {
		const thin = { challenges: [recognize('i1', 'el perro')] };
		const scripted = scriptedFetch([JSON.stringify(thin), JSON.stringify(plannedReply)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(scripted.calls).toBe(2);
		expect(result.challenges).toHaveLength(plan.length);
		// Usage is summed across both attempts.
		expect(result.usage).toEqual({ promptTokens: 1200, completionTokens: 1800 });
	});

	it('re-asks a chunk that answered in types nobody asked for', async () => {
		// A reply of the right *length* that is the wrong lesson: four
		// recognize-mc challenges where the plan asked for a spot-error, a cloze
		// and two translations. Counting could not tell the difference; the slot
		// check can, and the retry gets the lesson that was planned.
		const wrongTypes = {
			challenges: plan.map((slot) => recognize(slot.itemId, 'el perro'))
		};
		const scripted = scriptedFetch([JSON.stringify(wrongTypes), JSON.stringify(plannedReply)]);
		const result = await generateBatch(args, callOpts(scripted.fetchFn));

		expect(scripted.calls).toBe(2);
		expect(result.challenges.map((c) => c.type)).toEqual([
			'spot-error',
			'typed-translation',
			'cloze',
			'typed-translation'
		]);
	});

	it('throws bad-response after the retry also fails', async () => {
		const scripted = scriptedFetch(['not json at all', 'still not json']);
		const error = await generateBatch(args, callOpts(scripted.fetchFn)).catch((e: unknown) => e);

		expect(scripted.calls).toBe(2);
		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('bad-response');
	});

	it('throws bad-response when too few challenges survive twice', async () => {
		const thin = JSON.stringify({ challenges: [recognize('i1', 'el perro')] });
		const scripted = scriptedFetch([thin, thin]);
		await expect(generateBatch(args, callOpts(scripted.fetchFn))).rejects.toMatchObject({
			kind: 'bad-response'
		});
		expect(scripted.calls).toBe(2);
	});

	it('reports its progress steps in order, naming the model it waits on', async () => {
		const scripted = scriptedFetch([JSON.stringify(plannedReply)]);
		const steps: ProgressStep[] = [];
		await generateBatch(args, { ...callOpts(scripted.fetchFn), onProgress: (s) => steps.push(s) });

		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
		expect(steps[1].label).toContain('test/model');
		for (const step of steps) expect(step.label.length).toBeGreaterThan(0);
	});

	it('reports the retry step only when a corrective retry fires', async () => {
		const thin = { challenges: [recognize('i1', 'el perro')] };
		const scripted = scriptedFetch([JSON.stringify(thin), JSON.stringify(plannedReply)]);
		const steps: ProgressStep[] = [];
		await generateBatch(args, { ...callOpts(scripted.fetchFn), onProgress: (s) => steps.push(s) });

		// One step per id, whatever the chunks do: `request` covers every call in
		// flight, `retry` fires the first time any of them is re-asked, `validate`
		// once they have all settled.
		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'retry', 'validate']);
	});

	it('survives a progress callback that throws', async () => {
		// The step log is the caller's UI. Inside the pool a throw would surface as
		// an unhandled rejection in a sibling worker, which is a lost lesson and an
		// unreadable stack for a cosmetic listener.
		const scripted = scriptedFetch([JSON.stringify(plannedReply)]);
		const result = await generateBatch(args, {
			...callOpts(scripted.fetchFn),
			onProgress: () => {
				throw new Error('the UI blew up');
			}
		});
		expect(result.challenges).toHaveLength(plan.length);
	});

	it('says so when there is no vocabulary to write about, instead of blaming the model', async () => {
		// No call is made, so no step is announced and nothing is the model's
		// fault — the old path reported "the model returned something unusable".
		const scripted = scriptedFetch([JSON.stringify(plannedReply)]);
		const steps: ProgressStep[] = [];
		const error = await generateBatch(
			{ ...args, reviewItems: [] },
			{ ...callOpts(scripted.fetchFn), onProgress: (s) => steps.push(s) }
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).message).toContain('at least one word');
		expect(scripted.calls).toBe(0);
		expect(steps).toEqual([]);
	});

	it('does not demand five challenges from a two-challenge batch', async () => {
		const tinyArgs = { ...args, reviewItems: args.reviewItems.slice(0, 1), count: 1 };
		const tiny = fillPlan(planSlots(tinyArgs, IDENTITY_RNG));
		const scripted = scriptedFetch([JSON.stringify(tiny)]);
		const result = await generateBatch(tinyArgs, callOpts(scripted.fetchFn));
		expect(scripted.calls).toBe(1);
		expect(result.challenges).toHaveLength(1);
	});
});

/* -------------------------------------------------------------------------- */
/* Chunked, concurrent generation                                              */
/* -------------------------------------------------------------------------- */

/** Twelve review items — a full lesson, and therefore several chunks. */
const bigArgs: BatchArgs = {
	...args,
	reviewItems: Array.from({ length: 12 }, (_, i) => ({
		id: `w${i + 1}`,
		term: `term${i + 1}`,
		meaning: `meaning ${i + 1}`,
		level: 5 as const
	})),
	count: 20
};

/** The lesson `bigArgs` plans, as the chunker cuts it. `IDENTITY_RNG` is what `callOpts` passes. */
const bigChunks = chunkSlots(planSlots(bigArgs, IDENTITY_RNG), bigArgs.reviewItems);

/** A chunk's identity, so a fake reply can be scripted per chunk. */
const chunkKey = (slots: readonly { item?: string; itemId?: string; type: string }[]): string =>
	slots.map((s) => `${s.item ?? s.itemId}:${s.type}`).join('|');

/**
 * A fake that answers each request according to the *slots* it was asked for —
 * one challenge per slot, of that slot's own type, taken from that wire type's
 * fixture and stamped with the slot it fills — so a chunked reply is the brief
 * it was given, and "did the merge keep lesson order?" is a question with an
 * answer.
 *
 * Every reply resolves on a macrotask, which is what makes the fan-out real:
 * the pool can only have as many requests open at once as it is allowed to, and
 * `maxInFlight` records how many that was.
 */
function chunkFetch(
	options: {
		/** Chunk indices (into {@link bigChunks}) whose *first* reply is unusable. */
		failFirst?: Set<number>;
		/** Chunk indices that fail both times, and so must be dropped. */
		failAlways?: Set<number>;
		/** Chunk indices that answer every slot with a type nobody asked for. */
		wrongTypes?: Set<number>;
		/** Chunk indices that answer their brief and then keep writing. */
		overproduce?: Set<number>;
		/** Chunk indices that answer every cloze slot on the wrong side of `bank`. */
		flipBank?: Set<number>;
	} = {}
) {
	const index = new Map(bigChunks.map((chunk, i) => [chunkKey(chunk.slots), i] as const));
	const state = {
		calls: 0,
		inFlight: 0,
		maxInFlight: 0,
		seen: [] as number[],
		fetchFn: null as unknown as FetchLike
	};

	state.fetchFn = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
		const payload = JSON.parse(body.messages[1].content) as {
			slots: { item: string; type: string; bank?: boolean }[];
		};
		const which = index.get(chunkKey(payload.slots)) ?? -1;
		const isRetry = body.messages.length > 2;
		const flip = options.flipBank?.has(which) ?? false;
		const slots: SlotLike[] = payload.slots.map((slot) => ({
			itemId: slot.item,
			type: slot.type,
			...(slot.bank === undefined ? {} : { bank: flip ? !slot.bank : slot.bank })
		}));

		state.calls++;
		state.seen.push(payload.slots.length);
		state.inFlight++;
		state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
		await new Promise((resolve) => setTimeout(resolve, 0));
		state.inFlight--;

		const bad = options.failAlways?.has(which) || (!isRetry && options.failFirst?.has(which));
		const wrong = !isRetry && options.wrongTypes?.has(which);
		const challenges = bad
			? []
			: wrong
				? slots.map((slot) => recognize(slot.itemId, 'el perro'))
				: [
						...fillPlan(slots).challenges,
						// Three more about the chunk's first word, unasked for.
						...(options.overproduce?.has(which)
							? fillPlan([slots[0], slots[0], slots[0]]).challenges
							: [])
					];

		return new Response(
			JSON.stringify({
				model: 'test/model',
				choices: [{ message: { content: JSON.stringify({ challenges }) } }],
				usage: { prompt_tokens: 100, completion_tokens: 200 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return state;
}

describe('generateBatch, chunked', () => {
	it('fans a lesson out into one short request per chunk', async () => {
		const fake = chunkFetch();
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(bigChunks.length).toBeGreaterThan(1);
		expect(fake.calls).toBe(bigChunks.length);
		// Each request is short: a handful of slots about at most three words.
		for (const slots of fake.seen) expect(slots).toBeLessThanOrEqual(CHUNK_SLOTS);
		for (const chunk of bigChunks)
			expect(chunk.reviewItems.length).toBeLessThanOrEqual(CHUNK_ITEMS);
		expect(result.challenges).toHaveLength(20);
	});

	it('sums usage across every chunk and every retry', async () => {
		const fake = chunkFetch({ failFirst: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigChunks.length + 1);
		expect(result.usage).toEqual({
			promptTokens: 100 * fake.calls,
			completionTokens: 200 * fake.calls
		});
	});

	it('retries only the chunk that came back bad', async () => {
		const fake = chunkFetch({ failFirst: new Set([1]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigChunks.length + 1);
		expect(result.challenges).toHaveLength(20);
	});

	it('drops a chunk that fails twice instead of sinking the lesson', async () => {
		const fake = chunkFetch({ failAlways: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(result.challenges).toHaveLength(20 - bigChunks[0].slots.length);
		// The failed chunk cost two calls, every other chunk one.
		expect(fake.calls).toBe(bigChunks.length + 1);
	});

	it('throws bad-response only when the merged total misses the minimum', async () => {
		const fake = chunkFetch({ failAlways: new Set(bigChunks.map((_, i) => i)) });
		const error = await generateBatch(bigArgs, callOpts(fake.fetchFn)).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('bad-response');
		// Informative: how much survived, and how many requests failed.
		expect((error as LlmError).message).toContain('Only 0 usable');
		expect((error as LlmError).message).toContain(
			`${bigChunks.length} of ${bigChunks.length} requests failed`
		);
	});

	it('merges in lesson order, not completion order', async () => {
		const fake = chunkFetch();
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		// The fake stamps every challenge with the slot it filled, so the merged
		// lesson can be read back and compared with the plan it came from.
		const planned = bigChunks.flatMap((chunk) => chunk.slots.map((s) => `${s.itemId}-${s.type}`));
		expect(result.challenges.map((c) => c.explanation)).toEqual(planned);
	});

	it('trims a chunk that over-produces, and the chunks after it survive', async () => {
		// A chunk that answers its four slots and then writes three more used to
		// push the lesson past MAX_BATCH_CHALLENGES, and the merge sliced the tail
		// off — so a well-behaved later chunk paid for an earlier one's enthusiasm.
		const fake = chunkFetch({ overproduce: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(result.challenges).toHaveLength(20);
		const planned = bigChunks.flatMap((chunk) => chunk.slots.map((s) => `${s.itemId}-${s.type}`));
		expect(result.challenges.map((c) => c.explanation)).toEqual(planned);
	});

	it('drops a cloze answered on the wrong side of its word bank', async () => {
		// `bank` is the difference between two exercises for two stages of a word,
		// not a cosmetic detail — so a banked cloze does not fill a bankless slot.
		// One of four is ordinary salvage, so the chunk is not re-asked for it.
		const fake = chunkFetch({ flipBank: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		const clozeSlots = bigChunks[0].slots.filter((s) => s.type === 'cloze').length;
		expect(clozeSlots).toBeGreaterThan(0);
		expect(fake.calls).toBe(bigChunks.length);
		expect(result.challenges).toHaveLength(20 - clozeSlots);
		expect(result.challenges.map((c) => c.explanation)).not.toContain(
			`${bigChunks[0].slots.find((s) => s.type === 'cloze')?.itemId}-cloze`
		);
	});

	it('re-asks a chunk that answered in the wrong types, then merges it in place', async () => {
		const fake = chunkFetch({ wrongTypes: new Set([2]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigChunks.length + 1);
		expect(result.challenges).toHaveLength(20);
		const planned = bigChunks.flatMap((chunk) => chunk.slots.map((s) => `${s.itemId}-${s.type}`));
		expect(result.challenges.map((c) => c.explanation)).toEqual(planned);
	});

	it('runs at most CHUNK_CONCURRENCY requests at once', async () => {
		expect(bigChunks.length).toBeGreaterThan(CHUNK_CONCURRENCY);
		const fake = chunkFetch();
		await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.maxInFlight).toBe(CHUNK_CONCURRENCY);
	});

	it('says how many requests it is waiting on, in one step', async () => {
		const fake = chunkFetch();
		const steps: ProgressStep[] = [];
		await generateBatch(bigArgs, { ...callOpts(fake.fetchFn), onProgress: (s) => steps.push(s) });

		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
		expect(steps[1].label).toContain(`${bigChunks.length} requests`);
	});

	it('propagates an abort rather than reporting an unusable lesson', async () => {
		const controller = new AbortController();
		const fake = chunkFetch();
		controller.abort();

		const error = await generateBatch(bigArgs, {
			...callOpts(fake.fetchFn),
			signal: controller.signal
		}).catch((e: unknown) => e);

		expect((error as Error).name).toBe('AbortError');
		expect(fake.calls).toBe(0);
	});

	it('lets a key or rate-limit failure sink the lesson immediately', async () => {
		// Unlike a bad reply, this would meet every other chunk too — so "sink the
		// lesson" has to mean *now*, not after the remaining chunks have each
		// bought their own 429. The pool opens CHUNK_CONCURRENCY requests before
		// any of them can answer; nothing beyond those is ever dispatched.
		let calls = 0;
		const fetchFn: FetchLike = async () => {
			calls++;
			return new Response(JSON.stringify({ error: { message: 'no credit' } }), { status: 429 });
		};
		await expect(generateBatch(bigArgs, callOpts(fetchFn))).rejects.toMatchObject({
			kind: 'rate-limit'
		});

		expect(bigChunks.length).toBeGreaterThan(CHUNK_CONCURRENCY);
		expect(calls).toBe(CHUNK_CONCURRENCY);
	});

	it('cancels the requests still in flight when one chunk sinks the lesson', async () => {
		// The first chunk to fail fatally aborts its siblings rather than letting
		// them finish a lesson that is already lost.
		const aborted: boolean[] = [];
		let calls = 0;
		const fetchFn: FetchLike = async (_input, init) => {
			const mine = calls++;
			if (mine === 0) {
				return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
			aborted[mine] = init?.signal?.aborted ?? false;
			return new Response(JSON.stringify({ error: { message: 'too late' } }), { status: 500 });
		};

		await expect(generateBatch(bigArgs, callOpts(fetchFn))).rejects.toMatchObject({
			kind: 'auth'
		});
		expect(aborted.filter(Boolean).length).toBe(CHUNK_CONCURRENCY - 1);
	});
});

describe('resolveBatch', () => {
	it('drops a challenge whose every reference is unresolvable', () => {
		// Neither a known id nor a known term: with no vocabulary to mint, there is
		// nothing for this challenge to be about, so it never reaches the pool.
		const resolved = resolve({ challenges: [recognize('who?', 'x')] }, { knownItemIds: ['i1'] });
		expect(resolved.challenges).toHaveLength(0);
		expect(resolved.dropped).toBe(1);
	});

	describe('both-sides-in-target guard', () => {
		it('drops a recognize-mc whose "meanings" are in the target script', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'recognize-mc',
						shown: { text: '菜单', reading: 'càidān' },
						correctMeaning: '菜单',
						distractors: ['筷子', '茶', '水'],
						itemIds: ['i1'],
						explanation: null
					}
				]
			});
			expect(resolved.challenges).toHaveLength(0);
			expect(resolved.dropped).toBe(1);
		});

		it('drops a produce-mc whose prompt is already target text', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'produce-mc',
						promptNative: '菜单',
						correct: { text: '菜单', reading: 'càidān' },
						distractors: [
							{ text: '筷子', reading: 'kuàizi' },
							{ text: '茶', reading: 'chá' },
							{ text: '水', reading: 'shuǐ' }
						],
						instruction: null,
						itemIds: ['i1'],
						explanation: null
					}
				]
			});
			expect(resolved.challenges).toHaveLength(0);
			expect(resolved.dropped).toBe(1);
		});

		it('drops a translate-to-native whose accepted answers are target text', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'translate-to-native',
						prompt: { text: '买单', reading: 'mǎidān' },
						answersNative: ['买单'],
						itemIds: ['i1'],
						explanation: null
					}
				]
			});
			expect(resolved.challenges).toHaveLength(0);
			expect(resolved.dropped).toBe(1);
		});

		it('keeps no-space-script meanings when the target side is Latin — a zh-native learner', () => {
			const resolved = resolve({
				challenges: [
					{
						type: 'recognize-mc',
						shown: { text: 'the dog', reading: null },
						correctMeaning: '狗',
						distractors: ['猫', '面包', '房子'],
						itemIds: ['i1'],
						explanation: null
					}
				]
			});
			expect(resolved.challenges).toHaveLength(1);
			expect(resolved.dropped).toBe(0);
		});
	});

	it('counts malformed entries as dropped rather than failing', () => {
		const parsed = parseBatch(
			JSON.stringify({ challenges: [recognize('i1', 'ok'), { type: 'cloze' }] })
		);
		expect(parsed.challenges).toHaveLength(1);
		expect(parsed.dropped).toBe(1);
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
				expect(
					challenge.type === 'multiple-choice' && challenge.options[challenge.correctIndex]
				).toBe('the dog');
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
			const resolved = resolve({ challenges: [cloze] });
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

		it('merges a punctuation-only tile into the word before it', () => {
			const challenge = resolveWordOrder({
				words: [
					{ text: '你', reading: 'nǐ' },
					{ text: '好', reading: 'hǎo' },
					{ text: '吗', reading: 'ma' },
					{ text: '？', reading: null }
				],
				distractorWords: null
			});
			// "？" is not a tile: forgetting it is not a language mistake.
			expect(challenge?.answerTokens).toEqual(['你', '好', '吗？']);
			expect(challenge?.answer).toBe('你好吗？');
			expect(challenge?.tiles).toHaveLength(3);
		});

		it('merges leading punctuation into the word after it', () => {
			const challenge = resolveWordOrder({
				words: [
					{ text: '¿', reading: null },
					{ text: 'Nos', reading: null },
					{ text: 'trae', reading: null },
					{ text: 'la', reading: null },
					{ text: 'cuenta', reading: null },
					{ text: '?', reading: null }
				],
				distractorWords: null
			});
			expect(challenge?.answerTokens).toEqual(['¿Nos', 'trae', 'la', 'cuenta?']);
			expect(challenge?.answer).toBe('¿Nos trae la cuenta?');
		});

		it('drops a punctuation-only distractor: it is never a word', () => {
			const challenge = resolveWordOrder({
				distractorWords: [
					{ text: '？', reading: null },
					{ text: 'bebo', reading: null }
				]
			});
			expect(challenge?.tiles).toHaveLength(5);
			expect(challenge?.tiles).toContain('bebo');
			expect(challenge?.tiles).not.toContain('？');
		});

		it('shrinks the distractor allowance so the tray never exceeds MAX_WORD_ORDER_TILES', () => {
			const words = Array.from({ length: MAX_WORD_ORDER_TILES - 1 }, (_, i) => ({
				text: `w${i}`,
				reading: null
			}));
			const challenge = resolveWordOrder({
				words,
				distractorWords: [
					{ text: 'd1', reading: null },
					{ text: 'd2', reading: null },
					{ text: 'd3', reading: null }
				]
			});
			// Nine sentence tiles leave room for exactly one distractor.
			expect(challenge?.tiles).toHaveLength(MAX_WORD_ORDER_TILES);
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

/**
 * A spelling is not a word: 长 is `cháng` ("long") and `zhǎng` ("to grow"), and
 * a learner may hold both. What the prompt sends and what the resolver indexes
 * have to be the same string, so they are tested together.
 */
describe('knownTermLabels and knownTermIndex', () => {
	const homographs = [
		{ id: 'chang', term: '长', romanization: 'cháng' },
		{ id: 'zhang', term: '长', romanization: 'zhǎng' }
	];

	it('leaves a word with no sibling bare, reading or not', () => {
		expect(knownTermLabels([{ id: 'k1', term: '做饭', romanization: 'zuò fàn' }])).toEqual([
			'做饭'
		]);
	});

	it('leaves a homograph bare when it has no reading to be told apart by', () => {
		expect(knownTermLabels([{ id: 'a', term: '长' }, ...homographs])).toEqual([
			'长',
			'长 (cháng)',
			'长 (zhǎng)'
		]);
	});

	it('indexes each card under the label it travelled as', () => {
		const index = knownTermIndex({ ...args, reviewItems: [], knownItems: homographs });

		expect(index.get('长 (cháng)')).toBe('chang');
		expect(index.get('长 (zhǎng)')).toBe('zhang');
	});

	it('resolves a bare citation of an ambiguous term to the first card, always', () => {
		const index = knownTermIndex({ ...args, reviewItems: [], knownItems: homographs });
		const flipped = knownTermIndex({
			...args,
			reviewItems: [],
			knownItems: [...homographs].reverse()
		});

		expect(index.get('长')).toBe('chang');
		expect(flipped.get('长')).toBe('zhang');
	});

	it('lets a review item keep the bare key: the batch is about it', () => {
		const index = knownTermIndex({
			...args,
			reviewItems: [{ id: 'due', term: '长', meaning: 'to grow' }],
			knownItems: homographs
		});

		expect(index.get('长')).toBe('due');
		expect(index.get('长 (zhǎng)')).toBe('zhang');
	});
});
