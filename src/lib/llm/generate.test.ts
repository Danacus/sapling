import { describe, expect, it } from 'vitest';
import type { Challenge, KnowledgeItem } from '$lib/types';
import type { FetchLike } from './client';
import { LlmError } from './client';
import {
	MAX_ABOUT_CHARS,
	MAX_WORD_ORDER_DISTRACTORS,
	MAX_WORD_ORDER_TILES,
	buildRequestPrompt,
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
import { REQUEST_CONCURRENCY, REQUEST_ITEMS, groupIntoRequests } from './requests';
import type { ChallengeKind, TypeRequest, Want, WantItem } from './requests';

const PERRO: WantItem = { id: 'i1', term: 'el perro', meaning: 'the dog' };
const LEER: WantItem = { id: 'i2', term: 'leer', meaning: 'to read' };

function want(item: WantItem, kind: ChallengeKind, difficulty: Want['difficulty'] = 5): Want {
	return { item, kind, difficulty };
}

/**
 * Two solid words, each wanted in a recognition kind and a production kind, so
 * the brief is a mix of directions and shapes rather than four ways of
 * recognizing — the generation tests answer the brief they are given, so a
 * richer brief tests more of the pipeline. `recognize-mc` first: it has an
 * `instruction` field, which most of the prompt assertions are about.
 */
const args: BatchArgs = {
	profile: {
		nativeLanguage: 'English',
		targetLanguage: 'Spanish',
		level: 'beginner',
		interests: ['cooking', 'cycling']
	},
	wants: [
		want(PERRO, { type: 'recognize-mc' }),
		want(PERRO, { type: 'cloze', bank: true }),
		want(LEER, { type: 'translate-to-native' }),
		want(LEER, { type: 'translate-to-target' })
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

/**
 * The wire challenge a well-behaved model writes for one entry: that wire type's
 * own Spanish fixture, re-pointed at the entry's word and stamped in
 * `explanation` with the entry it fills.
 *
 * Using the registry's fixtures rather than a hand-rolled recognize-mc is what
 * makes these tests exercise every type end to end — the plan decides which
 * types a lesson asks for, and a reply now has to answer in *that* type or be
 * rejected before it is even parsed.
 */
function fillEntry(type: WireType, itemId: string, banked?: boolean): Record<string, unknown> {
	const def = byType.get(type);
	if (!def) throw new Error(`no wire def for ${type}`);
	const fixtures = def.fixtures.spanish as unknown as readonly {
		challenge: Record<string, unknown>;
	}[];
	const wanted =
		banked === undefined
			? fixtures[0]
			: (fixtures.find((f) => (f.challenge.distractorWords != null) === banked) ?? fixtures[0]);
	return { ...wanted.challenge, itemIds: [itemId], explanation: `${itemId}-${type}` };
}

/**
 * The requests `args` is cut into. Each want here is a kind of its own, so the
 * result comes back one challenge per want, in the order the wants were given.
 */
const requests = groupIntoRequests(args.wants);

/** Where the first challenge about this word lands in the result — for a citation test. */
const wantAbout = (itemId: string): number =>
	args.wants.findIndex((entry) => entry.item.id === itemId);

/** parse + resolve, the pairing every caller of this layer uses. */
function resolve(batch: { challenges: unknown[] }, opts: ResolveOptions = {}) {
	return resolveBatch(parseBatch(JSON.stringify(batch)), {
		newId: idFactory(),
		rng: IDENTITY_RNG,
		...opts
	});
}

/**
 * The type a request is about, read back out of its system prompt — which is the
 * only place it is named now. The payload does not carry a `type` at all.
 */
function typeOfPrompt(system: string): WireType {
	const match = /type \(always "([a-z-]+)"\)/.exec(system);
	if (!match) throw new Error('the system prompt does not name its type');
	return match[1] as WireType;
}

/** One request as the model saw it. */
interface SeenRequest {
	type: WireType;
	/** Only a cloze brief has a `bank` parameter, and it is a count, not a flag. */
	banked?: boolean;
	itemIds: string[];
	params: Record<string, number>[];
	retry: boolean;
}

function readRequest(rawBody: unknown): SeenRequest {
	const body = JSON.parse(String(rawBody)) as { messages: { content: string }[] };
	const payload = JSON.parse(body.messages[1].content) as {
		items: (Record<string, number> & { id: string })[];
	};
	const type = typeOfPrompt(body.messages[0].content);
	const params = payload.items.map(({ id: _id, t: _t, m: _m, ...rest }) => rest as never);
	return {
		type,
		...(type === 'cloze' ? { banked: (payload.items[0].bank ?? 0) > 0 } : {}),
		itemIds: payload.items.map((item) => item.id),
		params,
		retry: body.messages.length > 2
	};
}

/** A request's identity, so a fake can be scripted per request. */
function requestKey(request: SeenRequest | TypeRequest): string {
	if ('kind' in request) {
		return `${request.kind.type}:${request.kind.bank ?? ''}|${request.wants.map((w) => w.item.id).join(',')}`;
	}
	return `${request.type}:${request.banked ?? ''}|${request.itemIds.join(',')}`;
}

interface ModelBehaviour {
	/** Request indices whose *first* reply is unusable. */
	failFirst?: Set<number>;
	/** Request indices that fail both times, and so must be dropped. */
	failAlways?: Set<number>;
	/** Request indices that answer in a type nobody asked them for. */
	wrongTypes?: Set<number>;
	/** Request indices that answer their brief and then keep writing. */
	overproduce?: Set<number>;
	/** Request indices that answer a cloze brief on the wrong side of `bank`. */
	flipBank?: Set<number>;
	/** Wrap every reply in a ```json fence, as cheap models do. */
	fenced?: boolean;
	/** Extra entries appended to every reply — junk, ghosts, whatever. */
	extras?: Record<string, unknown>[];
	/** Last look at each challenge before it is sent. */
	rewrite?: (challenge: Record<string, unknown>, itemId: string, index: number) => unknown;
}

/**
 * A model that answers whatever brief it is handed: one challenge per item, of
 * the type the system prompt is about, taken from that type's own fixture and
 * stamped with the entry it fills. So a reply is the brief it was given, and
 * "did the merge put the lesson back in plan order?" is a question with an
 * answer.
 *
 * Every reply resolves on a macrotask, which is what makes the fan-out real: the
 * pool can only have as many requests open at once as it is allowed to, and
 * `maxInFlight` records how many that was.
 */
function modelFetch(plans: readonly TypeRequest[], options: ModelBehaviour = {}) {
	const index = new Map(plans.map((request, i) => [requestKey(request), i] as const));
	const state = {
		calls: 0,
		inFlight: 0,
		maxInFlight: 0,
		seen: [] as SeenRequest[],
		fetchFn: null as unknown as FetchLike
	};

	state.fetchFn = async (_input, init) => {
		const seen = readRequest(init?.body);
		const which = index.get(requestKey(seen)) ?? -1;
		state.calls++;
		state.seen.push(seen);
		state.inFlight++;
		state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
		await new Promise((resolve) => setTimeout(resolve, 0));
		state.inFlight--;

		const bad = options.failAlways?.has(which) || (!seen.retry && options.failFirst?.has(which));
		const wrong = !seen.retry && options.wrongTypes?.has(which);
		const type = wrong
			? seen.type === 'recognize-mc'
				? 'translate-to-native'
				: 'recognize-mc'
			: seen.type;
		const banked = options.flipBank?.has(which) ? !seen.banked : seen.banked;

		const written = bad
			? []
			: [
					...seen.itemIds.map((id) => fillEntry(type, id, banked)),
					// Three more about the brief's first word, unasked for.
					...(options.overproduce?.has(which)
						? [0, 1, 2].map(() => fillEntry(type, seen.itemIds[0], banked))
						: []),
					...(options.extras ?? [])
				];
		const challenges = options.rewrite
			? written.map(
					(challenge, i) => options.rewrite?.(challenge, seen.itemIds[i] ?? '', i) ?? challenge
				)
			: written;

		const content = JSON.stringify({ challenges });
		return new Response(
			JSON.stringify({
				model: 'test/model',
				choices: [
					{ message: { content: options.fenced ? '```json\n' + content + '\n```' : content } }
				],
				usage: { prompt_tokens: 600, completion_tokens: 900 }
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } }
		);
	};
	return state;
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
 * The messages for one request of a top-up. Everything about the *payload* that
 * the prompt tests care about — the profile, `topic`, `about`, `known` and the
 * key order — is identical on every request, so the first is a fair witness; the
 * system half is per type, so a test about prose says which type it is reading.
 * `args` puts `recognize-mc` first (a type with an `instruction` field, and the
 * one most of these assertions are about).
 */
function requestPrompt(batchArgs: BatchArgs = args, at = 0) {
	return buildRequestPrompt(batchArgs, groupIntoRequests(batchArgs.wants)[at]);
}

/** One request of one type about one word, at a rung. */
function requestFor(kind: ChallengeKind, difficulty: Want['difficulty'] = 3): TypeRequest {
	return { kind, wants: [want(PERRO, kind, difficulty)] };
}

/** The system prompt for one type, whatever a brief happens to ask for. */
function promptForType(type: WireType): string {
	const def = byType.get(type);
	if (!def) throw new Error(`no wire def for ${type}`);
	const [system] = buildRequestPrompt(
		args,
		requestFor({ type, ...(type === 'cloze' ? { bank: true } : {}) })
	);
	return system.content;
}

describe('buildRequestPrompt', () => {
	const messages = requestPrompt();

	it('is exactly one system and one user message', () => {
		expect(messages).toHaveLength(2);
		expect(messages[0].role).toBe('system');
		expect(messages[1].role).toBe('user');
	});

	it('describes the one type this request is about, and no other', () => {
		// The whole point of the split. A request for recognize-mc used to carry
		// six other types' field lists, examples and rules, and a slots list to
		// match them up against.
		const system = promptForType('recognize-mc');
		expect(system).toContain('recognize-mc');
		expect(system).toContain('correctMeaning');
		for (const other of [
			'produce-mc',
			'cloze',
			'translate-to-target',
			'translate-to-native',
			'word-order',
			'spot-error',
			'match-pairs'
		]) {
			expect(system, `recognize-mc's prompt mentions ${other}`).not.toContain(other);
		}
		// A batch has no vocabulary of its own to point at, so the only legal
		// references are an id it was given and a term it was shown.
		expect(system).not.toContain('new:<index>');
		expect(system).not.toContain('newItems');
	});

	it('spells the segmentation rule out in both tile types, and nowhere else', () => {
		// One tile per word is the rule that makes these types work for Chinese at
		// all; a per-character split would turn word order into calligraphy. Two
		// types need it, so both carry it — a duplicated line costs nothing it did
		// not already cost, since each copy only ever travels on its own calls.
		for (const type of ['word-order', 'spot-error'] as const) {
			const system = promptForType(type);
			expect(system, type).toContain('one tile per WORD');
			expect(system, type).toContain('菜单 is one tile');
		}
		expect(promptForType('cloze')).not.toContain('one tile per WORD');
	});

	it('states each type’s own answerability rule on its own prompt', () => {
		expect(promptForType('word-order')).toContain('exactly one natural order');
		expect(promptForType('spot-error')).toContain('unambiguously wrong');
		// The shuffle and the corruption are the app's, and the prompt says so.
		expect(promptForType('word-order')).toContain('the app shuffles the tiles');
		expect(promptForType('spot-error')).toContain('the app replaces words[wrongPosition]');
	});

	it('carries the instruction heading rule only where there is a field for it', () => {
		for (const type of ['recognize-mc', 'produce-mc', 'word-order'] as const) {
			expect(promptForType(type), type).toContain('Pick the best reply');
		}
		for (const type of ['cloze', 'spot-error', 'translate-to-native'] as const) {
			expect(promptForType(type), type).not.toContain('Pick the best reply');
		}
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
		// One list, not two: the words the lesson is about *are* the brief now.
		expect(payload).not.toHaveProperty('reviewItems');
		expect(payload).not.toHaveProperty('slots');
	});

	it('lists the words to write about, with the sizes to write them at', () => {
		const payload = JSON.parse(messages[1].content) as {
			items: (Record<string, unknown> & { id: string; t: string; m: string })[];
		};
		const terms = new Map(args.wants.map((w) => [w.item.id, w.item] as const));
		for (const entry of payload.items) {
			// The word and its meaning ride beside the id, so the brief reads
			// without a lookup.
			expect(entry.t).toBe(terms.get(entry.id)?.term);
			expect(entry.m).toBe(terms.get(entry.id)?.meaning);
			// recognize-mc is sized by one number, and it is a word count.
			expect(typeof entry.words).toBe('number');
		}
	});

	it('sends countable parameters, never a type or a difficulty', () => {
		// The two things this rewrite exists to remove from the payload. `type` is
		// the subject of the system prompt; `difficulty` was a scale the model had
		// to interpret, and is now a set of lengths it can count. (`bank` survives
		// as a *count* of words, not as the flag the plan holds.)
		for (const request of requests) {
			const [, user] = buildRequestPrompt(args, request);
			const payload = JSON.parse(user.content) as { items: Record<string, unknown>[] };
			for (const entry of payload.items) {
				expect(entry).not.toHaveProperty('type');
				expect(entry).not.toHaveProperty('difficulty');
				expect(entry).not.toHaveProperty('level');
				for (const [key, value] of Object.entries(entry)) {
					if (['id', 't', 'm'].includes(key)) continue;
					expect(typeof value, key).toBe('number');
				}
			}
		}
	});

	it('grows the sizes it sends as the rung rises', () => {
		const wordsAt = (difficulty: 1 | 5): number => {
			const [, user] = buildRequestPrompt(
				args,
				requestFor({ type: 'translate-to-native' }, difficulty)
			);
			return (JSON.parse(user.content) as { items: { words: number }[] }).items[0].words;
		};
		expect(wordsAt(1)).toBeLessThan(wordsAt(5));
	});

	it('sends a cloze its bank size, as a count including the answer', () => {
		const bankAt = (bank: boolean): number => {
			const [, user] = buildRequestPrompt(args, requestFor({ type: 'cloze', bank }, 1));
			return (JSON.parse(user.content) as { items: { bank: number }[] }).items[0].bank;
		};
		// Six candidates at the easy end; nothing at all when the want asked for a
		// typed cloze, which is what `bank: false` means.
		expect(bankAt(true)).toBe(6);
		expect(bankAt(false)).toBe(0);
	});

	it('writes everything shared across requests before the brief itself', () => {
		// Prompt caching pays up to the first byte that differs. `known` is the
		// biggest block and identical on every request of a lesson, so it belongs
		// above the one key that is the whole reason there are several requests.
		const withKnown = requestPrompt({
			...args,
			topic: 'ordering in a restaurant',
			knownItems: [{ id: 'k1', term: '做饭' }]
		});
		const keys = Object.keys(JSON.parse(withKnown[1].content) as Record<string, unknown>);
		const shared = ['native', 'target', 'level', 'topic', 'interests', 'known'];
		for (const key of [...shared, 'items']) expect(keys).toContain(key);
		expect(Math.max(...shared.map((k) => keys.indexOf(k)))).toBeLessThan(keys.indexOf('items'));
	});

	it('is byte-identical up to the brief across every request of a lesson', () => {
		const withKnown: BatchArgs = {
			...args,
			topic: 'ordering in a restaurant',
			knownItems: [{ id: 'k1', term: '做饭' }]
		};
		const prefixes = groupIntoRequests(withKnown.wants).map((request) => {
			const [, user] = buildRequestPrompt(withKnown, request);
			return user.content.slice(0, user.content.indexOf('"items"'));
		});
		expect(prefixes.length).toBeGreaterThan(1);
		expect(new Set(prefixes).size).toBe(1);
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
		const content = requestPrompt({ ...args, knownItems: known })[1].content;
		const payload = JSON.parse(content) as Record<string, unknown>;
		expect(payload.known).toEqual(['名字', '做饭', '点菜']);
		expect(content).not.toContain('k1');

		expect(JSON.parse(messages[1].content)).not.toHaveProperty('known');
		expect(JSON.parse(requestPrompt({ ...args, knownItems: [] })[1].content)).not.toHaveProperty(
			'known'
		);
	});

	it('qualifies a known term only when the collection holds two of that spelling', () => {
		// A reading costs tokens and buys nothing where the spelling is already
		// unique — which is every word, for nearly every learner.
		const payload = JSON.parse(
			requestPrompt({
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

	it('explains the parameters instead of a difficulty scale', () => {
		const system = messages[0].content;
		// No ladder, no scale, no dial the model has to interpret.
		expect(system).not.toContain('1-5');
		expect(system).not.toContain('1 easiest');
		expect(system).not.toContain('Difficulty calibration');
		expect(system).not.toContain('recentAccuracy');
		expect(system).not.toContain('recentMistakes');
		expect(system).not.toContain('(skipped)');
		// What replaces it: this type's own keys, named and explained.
		expect(system).toContain('words: how many words');
		expect(system).toContain('Treat every size as a target to hit');
		// And one rule tying the brief to the reply.
		expect(system).toContain('items is the exact lesson to write');
		expect(system).not.toContain('Match type to maturity');
		expect(system).not.toContain('Mix recognition and production');
	});

	it('threads the session topic into the user message, ahead of interests', () => {
		const withTopic = requestPrompt({ ...args, topic: 'ordering in a restaurant' });
		const raw = withTopic[1].content;
		expect(raw).toContain('ordering in a restaurant');

		const payload = JSON.parse(raw) as Record<string, unknown>;
		expect(payload.topic).toBe('ordering in a restaurant');
		const keys = Object.keys(payload);
		expect(keys.indexOf('topic')).toBeLessThan(keys.indexOf('interests'));
	});

	it("sends the learner's self-description when they wrote one", () => {
		const withAbout = requestPrompt({
			...args,
			profile: { ...args.profile, about: 'Nurse in Valencia, two kids, I climb on weekends.' }
		});
		const payload = JSON.parse(withAbout[1].content) as Record<string, unknown>;
		expect(payload.about).toBe('Nurse in Valencia, two kids, I climb on weekends.');
	});

	it('omits about when it is absent or blank', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('about');
		const blank = requestPrompt({ ...args, profile: { ...args.profile, about: '  \n ' } });
		expect(JSON.parse(blank[1].content)).not.toHaveProperty('about');
	});

	it('caps about, so the token budget never depends on how much they typed', () => {
		const essay = 'x'.repeat(1000);
		const payload = JSON.parse(
			requestPrompt({ ...args, profile: { ...args.profile, about: essay } })[1].content
		) as Record<string, unknown>;
		expect(payload.about).toHaveLength(MAX_ABOUT_CHARS);
		expect(payload.about).toBe('x'.repeat(MAX_ABOUT_CHARS));
	});

	it('tells the model what about is for', () => {
		expect(messages[0].content).toContain('"about"');
	});

	it('omits the topic key entirely when there is none', () => {
		expect(JSON.parse(messages[1].content)).not.toHaveProperty('topic');
		const blank = requestPrompt({ ...args, topic: '   ' });
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
		// The rule that keeps grading local and free for non-Latin scripts lives
		// with the one type that would otherwise spend tokens on the variants.
		expect(promptForType('translate-to-target')).toContain('the app derives those from "reading"');
	});

	it('explains that the app, not the model, places the cloze blank', () => {
		const system = promptForType('cloze');
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
		// The one-right-answer rule is generic now; the count of options is the
		// multiple-choice types' own business.
		expect(system).toContain('never a second right answer');
		expect(promptForType('recognize-mc')).toContain('exactly one of the four options');
	});

	it('is composed once per type and handed back the same string', () => {
		// Static per type is what keeps prompt caching paying: every request of one
		// kind, in this lesson and the next, quotes a byte-identical prefix.
		expect(promptForType('cloze')).toBe(promptForType('cloze'));
		expect(promptForType('cloze')).not.toBe(promptForType('spot-error'));
	});
});

describe('generateBatch', () => {
	it('assigns ids and returns challenges only, never vocabulary', async () => {
		const fake = modelFetch(requests);
		const result = await generateBatch(args, callOpts(fake.fetchFn));

		expect(result.challenges).toHaveLength(args.wants.length);
		expect(fake.calls).toBe(requests.length);
		expect(result.usage).toEqual({
			promptTokens: 600 * requests.length,
			completionTokens: 900 * requests.length
		});
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

	it('asks each request for one type, and gets that type back', async () => {
		const fake = modelFetch(requests);
		await generateBatch(args, callOpts(fake.fetchFn));

		expect(new Set(fake.seen.map((seen) => seen.type)).size).toBe(requests.length);
		for (const seen of fake.seen) {
			expect(seen.itemIds.length).toBeGreaterThan(0);
			expect(seen.itemIds.length).toBeLessThanOrEqual(REQUEST_ITEMS);
			for (const params of seen.params) expect(Object.keys(params).length).toBeGreaterThan(0);
		}
	});

	it('derives direction from the challenge type', async () => {
		const fake = modelFetch(requests);
		const result = await generateBatch(args, callOpts(fake.fetchFn));
		// The wants in `args`, each resolving into the direction its wire def
		// declares, never one the model chose.
		expect(args.wants.map((w) => w.kind.type)).toEqual([
			'recognize-mc',
			'cloze',
			'translate-to-native',
			'translate-to-target'
		]);
		expect(result.challenges.map((c) => c.direction)).toEqual([
			'toNative',
			'toTarget',
			'toNative',
			'toTarget'
		]);
	});

	it('strips markdown fences around the JSON', async () => {
		const fake = modelFetch(requests, { fenced: true });
		const result = await generateBatch(args, callOpts(fake.fetchFn));
		expect(result.challenges).toHaveLength(args.wants.length);
	});

	it('salvages the batch when a single challenge is malformed', async () => {
		const fake = modelFetch(requests, {
			extras: [{ type: 'recognize-mc', shown: { text: 'x' }, distractors: ['a', 'b'] }]
		});
		const result = await generateBatch(args, callOpts(fake.fetchFn));

		expect(result.challenges).toHaveLength(args.wants.length);
		expect(fake.calls).toBe(requests.length);
	});

	it('drops challenges that reference an id the model invented', async () => {
		const fake = modelFetch(requests, {
			extras: [recognize('i-does-not-exist', 'ghost')]
		});
		const result = await generateBatch(args, callOpts(fake.fetchFn));
		expect(result.challenges).toHaveLength(args.wants.length);
	});

	it('honours itemIds cited by term — known words and review items alike', async () => {
		// Known words travel to the model as bare terms with no ids at all, so a
		// challenge built on one can only cite the word itself. Dropping those as
		// "hallucinated" is what made whole batches come back unusable.
		const fake = modelFetch(requests, {
			rewrite: (challenge, itemId) =>
				itemId === 'i1'
					? { ...challenge, itemIds: [' El Perro '] } // a review item, cited sloppily by term
					: { ...challenge, itemIds: ['i2', '做饭'] } // plus a known word, the only way it can be cited
		});
		const result = await generateBatch(
			{ ...args, knownItems: [{ id: 'k9', term: '做饭' }] },
			callOpts(fake.fetchFn)
		);

		expect(result.challenges).toHaveLength(args.wants.length);
		expect(result.challenges[wantAbout('i1')].itemIds).toEqual(['i1']);
		expect(result.challenges[wantAbout('i2')].itemIds).toEqual(['i2', 'k9']);
	});

	it('resolves a homograph cited with its reading onto that card, not its sibling', async () => {
		// The whole round trip: the prompt renders `长 (zhǎng)`, the model cites it
		// back, and the resolver puts the review credit on the right of two cards.
		const knownItems = [
			{ id: 'chang', term: '长', romanization: 'cháng' },
			{ id: 'zhang', term: '长', romanization: 'zhǎng' }
		];
		const fake = modelFetch(requests, {
			rewrite: (challenge, itemId) =>
				itemId === 'i1'
					? { ...challenge, itemIds: ['i1', '长 (zhǎng)'] }
					: { ...challenge, itemIds: ['i2', '长'] } // Bare: a coin the app does not flip.
		});
		const result = await generateBatch({ ...args, knownItems }, callOpts(fake.fetchFn));

		expect(result.challenges[wantAbout('i1')].itemIds).toEqual(['i1', 'zhang']);
		expect(result.challenges[wantAbout('i2')].itemIds).toEqual(['i2', 'chang']);
	});

	it('retries once with a corrective instruction, then succeeds', async () => {
		const fake = modelFetch(requests, { failFirst: new Set([0]) });
		const result = await generateBatch(args, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(requests.length + 1);
		// The retry restates only the type it is about, never the other six.
		const retry = fake.seen.filter((seen) => seen.retry);
		expect(retry).toHaveLength(1);
		expect(retry[0].type).toBe(requests[0].kind.type);
		expect(result.challenges).toHaveLength(args.wants.length);
	});

	it('throws bad-response after the retry also fails', async () => {
		const scripted = scriptedFetch(['not json at all', 'still not json']);
		const error = await generateBatch(args, callOpts(scripted.fetchFn)).catch((e: unknown) => e);

		expect(scripted.calls).toBe(requests.length * 2);
		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('bad-response');
	});

	it('throws bad-response when too few challenges survive twice', async () => {
		const fake = modelFetch(requests, { failAlways: new Set(requests.map((_, i) => i)) });
		await expect(generateBatch(args, callOpts(fake.fetchFn))).rejects.toMatchObject({
			kind: 'bad-response'
		});
		expect(fake.calls).toBe(requests.length * 2);
	});

	it('reports its progress steps in order, naming the model it waits on', async () => {
		const fake = modelFetch(requests);
		const steps: ProgressStep[] = [];
		await generateBatch(args, { ...callOpts(fake.fetchFn), onProgress: (s) => steps.push(s) });

		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
		expect(steps[1].label).toContain('test/model');
		for (const step of steps) expect(step.label.length).toBeGreaterThan(0);
	});

	it('reports the retry step only when a corrective retry fires', async () => {
		const fake = modelFetch(requests, { failFirst: new Set([1]) });
		const steps: ProgressStep[] = [];
		await generateBatch(args, { ...callOpts(fake.fetchFn), onProgress: (s) => steps.push(s) });

		// One step per id, whatever the requests do: `request` covers every call in
		// flight, `retry` fires the first time any of them is re-asked, `validate`
		// once they have all settled.
		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'retry', 'validate']);
	});

	it('survives a progress callback that throws', async () => {
		// The step log is the caller's UI. Inside the pool a throw would surface as
		// an unhandled rejection in a sibling worker, which is a lost lesson and an
		// unreadable stack for a cosmetic listener.
		const fake = modelFetch(requests);
		const result = await generateBatch(args, {
			...callOpts(fake.fetchFn),
			onProgress: () => {
				throw new Error('the UI blew up');
			}
		});
		expect(result.challenges).toHaveLength(args.wants.length);
	});

	it('says so when nothing was asked for, instead of blaming the model', async () => {
		// No call is made, so no step is announced and nothing is the model's
		// fault — the old path reported "the model returned something unusable".
		const fake = modelFetch(requests);
		const steps: ProgressStep[] = [];
		const error = await generateBatch(
			{ ...args, wants: [] },
			{ ...callOpts(fake.fetchFn), onProgress: (s) => steps.push(s) }
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).message).toContain('nothing to write');
		expect(fake.calls).toBe(0);
		expect(steps).toEqual([]);
	});

	it('fills a single want with a single request, and no minimum to clear', async () => {
		const tinyArgs = { ...args, wants: args.wants.slice(0, 1) };
		const fake = modelFetch(groupIntoRequests(tinyArgs.wants));
		const result = await generateBatch(tinyArgs, callOpts(fake.fetchFn));
		expect(fake.calls).toBe(1);
		expect(result.challenges).toHaveLength(1);
		expect(result.failedRequests).toBe(0);
	});
});

/* -------------------------------------------------------------------------- */
/* Concurrent, one-type-at-a-time generation                                   */
/* -------------------------------------------------------------------------- */

const RECOGNITION_KINDS: ChallengeKind[] = [
	{ type: 'recognize-mc' },
	{ type: 'produce-mc' },
	{ type: 'translate-to-native' },
	{ type: 'spot-error' }
];
const PRODUCTION_KINDS: ChallengeKind[] = [
	{ type: 'word-order' },
	{ type: 'cloze', bank: true },
	{ type: 'translate-to-target' },
	{ type: 'cloze', bank: false }
];

/**
 * Twelve words, each wanted in a recognition kind and a production kind, the
 * kinds dealt round so every one of the eight is asked for three times — a full
 * top-up, and therefore several requests of several words each.
 */
const bigArgs: BatchArgs = {
	...args,
	wants: Array.from({ length: 12 }, (_, i) => {
		const item = { id: `w${i + 1}`, term: `term${i + 1}`, meaning: `meaning ${i + 1}` };
		return [want(item, RECOGNITION_KINDS[i % 4]), want(item, PRODUCTION_KINDS[i % 4])];
	}).flat()
};

const bigRequests = groupIntoRequests(bigArgs.wants);

/** The stamp the fake writes on the challenge that fills a want. */
const stampOf = (entry: Want): string => `${entry.item.id}-${entry.kind.type}`;

/** The stamps a request contributes, in brief order. */
const stampsOf = (request: TypeRequest): string[] => request.wants.map(stampOf);

/**
 * How the result must read: request order, brief order within each — which is
 * *not* the order the wants were given in, since they were dealt per word.
 */
const bigStamps = bigRequests.flatMap(stampsOf);

describe('generateBatch, one request per type', () => {
	it('fans a lesson out into one request per kind, each a handful of words', async () => {
		const fake = modelFetch(bigRequests);
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(bigRequests.length).toBeGreaterThan(1);
		expect(fake.calls).toBe(bigRequests.length);
		// Grouping by kind is what makes the requests few and long: one per kind,
		// each about several words, rather than one per word.
		expect(bigRequests).toHaveLength(8);
		for (const seen of fake.seen) {
			expect(seen.itemIds.length).toBe(3);
			expect(seen.itemIds.length).toBeLessThanOrEqual(REQUEST_ITEMS);
		}
		expect(result.challenges).toHaveLength(bigArgs.wants.length);
		expect(result.failedRequests).toBe(0);
	});

	it('never asks one request about the same word twice', async () => {
		const fake = modelFetch(bigRequests);
		await generateBatch(bigArgs, callOpts(fake.fetchFn));
		for (const seen of fake.seen) {
			expect(new Set(seen.itemIds).size).toBe(seen.itemIds.length);
		}
	});

	it('sums usage across every request and every retry', async () => {
		const fake = modelFetch(bigRequests, { failFirst: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigRequests.length + 1);
		expect(result.usage).toEqual({
			promptTokens: 600 * fake.calls,
			completionTokens: 900 * fake.calls
		});
	});

	it('retries only the request that came back bad', async () => {
		const fake = modelFetch(bigRequests, { failFirst: new Set([1]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigRequests.length + 1);
		expect(result.challenges).toHaveLength(bigArgs.wants.length);
		// A retry that succeeded is not a failed request.
		expect(result.failedRequests).toBe(0);
	});

	it('drops a request that fails twice instead of sinking the top-up, and says so', async () => {
		const fake = modelFetch(bigRequests, { failAlways: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(result.challenges).toHaveLength(bigArgs.wants.length - bigRequests[0].wants.length);
		expect(result.failedRequests).toBe(1);
		// The failed request cost two calls, every other one call.
		expect(fake.calls).toBe(bigRequests.length + 1);
		// And what survives is still the rest of the brief, in order — the hole
		// the dropped request leaves does not reshuffle anything.
		const lost = new Set(stampsOf(bigRequests[0]));
		expect(result.challenges.map((c) => c.explanation)).toEqual(
			bigStamps.filter((stamp) => !lost.has(stamp))
		);
	});

	it('throws bad-response only when every request came back empty', async () => {
		const fake = modelFetch(bigRequests, { failAlways: new Set(bigRequests.map((_, i) => i)) });
		const error = await generateBatch(bigArgs, callOpts(fake.fetchFn)).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('bad-response');
		// Informative: nothing survived, and every request failed.
		expect((error as LlmError).message).toContain('Nothing usable');
		expect((error as LlmError).message).toContain(`all ${bigRequests.length} requests failed`);
	});

	it('returns in request order and brief order, never completion order', async () => {
		const fake = modelFetch(bigRequests);
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		// The fake stamps every challenge with the want it filled, so the result
		// can be read back against the requests it was cut into. Completion order
		// is whatever the fake's timers made it; the result does not follow it.
		expect(result.challenges.map((c) => c.explanation)).toEqual(bigStamps);
		expect(bigStamps).not.toEqual(bigArgs.wants.map(stampOf));
	});

	it('trims a request that over-produces, and the ones after it survive', async () => {
		// A request that answers its entries and then writes three more: the
		// extras match no unfilled entry and are dropped, so a well-behaved later
		// request never pays for an earlier one's enthusiasm.
		const fake = modelFetch(bigRequests, { overproduce: new Set([0]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(result.challenges).toHaveLength(bigArgs.wants.length);
		expect(result.challenges.map((c) => c.explanation)).toEqual(bigStamps);
	});

	it('holds a typed cloze to its brief even when the model sends a bank anyway', async () => {
		// `bank: 0` is a parameter the resolver can enforce, so a word bank nobody
		// asked for is discarded rather than quietly turning a retrieval exercise
		// into the easier one. No retry: the challenge that comes out *is* the
		// challenge that was asked for.
		const clozeAt = bigRequests.findIndex(
			(request) => request.kind.type === 'cloze' && request.kind.bank === false
		);
		expect(clozeAt).toBeGreaterThanOrEqual(0);
		const fake = modelFetch(bigRequests, { flipBank: new Set([clozeAt]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigRequests.length);
		expect(result.challenges.map((c) => c.explanation)).toEqual(bigStamps);
		for (const challenge of result.challenges) {
			if (
				challenge.type === 'cloze' &&
				bigRequests[clozeAt].wants.some((w) => challenge.itemIds.includes(w.item.id))
			) {
				expect(challenge).not.toHaveProperty('wordBank');
			}
		}
	});

	it('drops a banked cloze answered without its word bank', async () => {
		// The direction the resolver cannot rescue: a bank was asked for and none
		// came back, which is the harder exercise, not the one this word is ready
		// for. So the request is re-asked and then dropped.
		const clozeAt = bigRequests.findIndex((request) => request.kind.bank === true);
		expect(clozeAt).toBeGreaterThanOrEqual(0);

		const fake = modelFetch(bigRequests, { flipBank: new Set([clozeAt]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigRequests.length + 1);
		expect(result.failedRequests).toBe(1);
		const lost = new Set(stampsOf(bigRequests[clozeAt]));
		expect(result.challenges.map((c) => c.explanation)).toEqual(
			bigStamps.filter((stamp) => !lost.has(stamp))
		);
	});

	it('re-asks a request that answered in the wrong type, then merges it in place', async () => {
		const fake = modelFetch(bigRequests, { wrongTypes: new Set([2]) });
		const result = await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.calls).toBe(bigRequests.length + 1);
		expect(result.challenges).toHaveLength(bigArgs.wants.length);
		expect(result.challenges.map((c) => c.explanation)).toEqual(bigStamps);
	});

	it('runs at most REQUEST_CONCURRENCY requests at once', async () => {
		expect(bigRequests.length).toBeGreaterThan(REQUEST_CONCURRENCY);
		const fake = modelFetch(bigRequests);
		await generateBatch(bigArgs, callOpts(fake.fetchFn));

		expect(fake.maxInFlight).toBe(REQUEST_CONCURRENCY);
	});

	it('says how many requests it is waiting on, in one step', async () => {
		const fake = modelFetch(bigRequests);
		const steps: ProgressStep[] = [];
		await generateBatch(bigArgs, { ...callOpts(fake.fetchFn), onProgress: (s) => steps.push(s) });

		expect(steps.map((s) => s.id)).toEqual(['build-prompt', 'request', 'validate']);
		expect(steps[1].label).toContain(`${bigRequests.length} requests`);
	});

	it('propagates an abort rather than reporting an unusable lesson', async () => {
		const controller = new AbortController();
		const fake = modelFetch(bigRequests);
		controller.abort();

		const error = await generateBatch(bigArgs, {
			...callOpts(fake.fetchFn),
			signal: controller.signal
		}).catch((e: unknown) => e);

		expect((error as Error).name).toBe('AbortError');
		expect(fake.calls).toBe(0);
	});

	it('lets a key or rate-limit failure sink the lesson immediately', async () => {
		// Unlike a bad reply, this would meet every other request too — so "sink the
		// lesson" has to mean *now*, not after the remaining requests have each
		// bought their own 429. The pool opens REQUEST_CONCURRENCY requests before
		// any of them can answer; nothing beyond those is ever dispatched.
		let calls = 0;
		const fetchFn: FetchLike = async () => {
			calls++;
			return new Response(JSON.stringify({ error: { message: 'no credit' } }), { status: 429 });
		};
		await expect(generateBatch(bigArgs, callOpts(fetchFn))).rejects.toMatchObject({
			kind: 'rate-limit'
		});

		expect(bigRequests.length).toBeGreaterThan(REQUEST_CONCURRENCY);
		expect(calls).toBe(REQUEST_CONCURRENCY);
	});

	it('cancels the requests still in flight when one of them sinks the lesson', async () => {
		// The first request to fail fatally aborts its siblings rather than letting
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
		expect(aborted.filter(Boolean).length).toBe(REQUEST_CONCURRENCY - 1);
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

		it('trims the bank to the size the challenge was planned at', () => {
			// A parameter the resolver can hold the model to: the bank is how much
			// support a word at this rung gets, so a generous one is cut back rather
			// than making the challenge quietly easier than the plan asked for.
			const challenge = resolveCloze(
				{
					distractorWords: ['筷子', '茶', '水', '碗', '杯子'].map((text) => ({
						text,
						reading: null
					}))
				},
				{ paramsByItem: new Map([['i1', { words: 7, bank: 3 }]]) }
			);
			expect(challenge?.wordBank).toHaveLength(3);
			expect(challenge?.wordBank).toContain('菜单');
		});

		it('drops a bank the plan did not ask for at all', () => {
			// `bank: 0` was a request for a typed cloze. Distractors sent anyway are
			// discarded: the two are different exercises for different stages.
			const challenge = resolveCloze({}, { paramsByItem: new Map([['i1', { bank: 0 }]]) });
			expect('wordBank' in (challenge ?? {})).toBe(false);
			expect(challenge?.acceptedAnswers).toContain('菜单');
		});

		it('leaves the bank alone when no parameters travelled with it', () => {
			// The mock and a bare `resolveBatch` pass none, and must behave exactly
			// as they did before.
			expect(resolveCloze()?.wordBank).toHaveLength(4);
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

		it('caps the distractors at the count the challenge was planned with', () => {
			// Extra tiles are the second half of this type's difficulty, so a tray
			// padded past the plan is trimmed rather than left as a harder puzzle.
			const challenge = resolveWordOrder(
				{
					distractorWords: ['bebo', 'como', 'corro'].map((text) => ({ text, reading: null }))
				},
				{ paramsByItem: new Map([['i1', { tiles: 4, distractors: 1 }]]) }
			);
			expect(challenge?.tiles).toHaveLength(5);

			// Nothing at all at the bottom of the ladder.
			const bare = resolveWordOrder(
				{ distractorWords: [{ text: 'bebo', reading: null }] },
				{ paramsByItem: new Map([['i1', { tiles: 3, distractors: 0 }]]) }
			);
			expect(bare?.tiles).toHaveLength(4);
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

	/**
	 * The free round is sized off the same 1-5 ladder every paid type is written
	 * to. These pin the ladder itself, its bounds against the stored side's
	 * `FEWEST_PAIRS`/`MOST_PAIRS` scale, and the two ways a short vocabulary can
	 * land.
	 */
	describe('ladder sizing', () => {
		const rungs = [1, 2, 3, 4, 5] as const;

		/** Twelve collision-free words, so every rung can be satisfied outright. */
		const plenty: KnowledgeItem[] = Array.from({ length: 12 }, (_, i) => ({
			id: `p${i}`,
			kind: 'vocab',
			term: `term-${i}`,
			meaning: `meaning-${i}`,
			fsrsCard: null,
			introducedAt: 0,
			history: []
		}));

		const pairCount = (challenge: Challenge | undefined) =>
			challenge?.type === 'match-pairs' ? challenge.pairs.length : undefined;

		it('never falls as the rung rises, and stays inside the stored 2..6 scale', () => {
			const counts = rungs.map((rung) =>
				pairCount(makeMatchPairsChallenge(plenty, () => 0.5, { difficulty: rung }))
			);

			expect(counts).toEqual([...counts].sort((a, b) => (a ?? 0) - (b ?? 0)));
			for (const count of counts) {
				expect(count).toBeGreaterThanOrEqual(2);
				expect(count).toBeLessThanOrEqual(6);
			}
			// The whole ladder is exercised: the top rung asks for more than the
			// bottom one, or sizing would be a no-op that still typechecked.
			expect(counts.at(-1)).toBeGreaterThan(counts[0] ?? 0);
		});

		it('honours each rung exactly when there are words enough', () => {
			const counts = rungs.map((rung) =>
				pairCount(makeMatchPairsChallenge(plenty, () => 0.5, { difficulty: rung }))
			);
			expect(counts).toEqual([3, 4, 5, 6, 6]);
		});

		it('builds the smaller round rather than declining when words run short', () => {
			// Rung 5 wants six; three collision-free words is still a playable round
			// and still above the ladder's own floor.
			const three = plenty.slice(0, 3);
			expect(pairCount(makeMatchPairsChallenge(three, () => 0.5, { difficulty: 5 }))).toBe(3);
			expect(
				pairCount(makeMatchPairsChallenge(plenty.slice(0, 5), () => 0.5, { difficulty: 4 }))
			).toBe(5);
		});

		it('declines below the smallest round the ladder can ask for', () => {
			expect(
				makeMatchPairsChallenge(plenty.slice(0, 2), () => 0.5, { difficulty: 1 })
			).toBeUndefined();
			// Collisions are resolved before the floor is applied, exactly as they
			// are for an unsized round.
			const clashing = [...plenty.slice(0, 2), { ...plenty[2], meaning: plenty[0].meaning }];
			expect(makeMatchPairsChallenge(clashing, () => 0.5, { difficulty: 3 })).toBeUndefined();
		});

		it('leaves an unsized round exactly as it was', () => {
			// No `difficulty`: the four-or-five draw, and the old four-item floor.
			for (let seed = 0; seed < 20; seed++) {
				const count = pairCount(makeMatchPairsChallenge(plenty, () => seed / 20));
				expect(count).toBeGreaterThanOrEqual(4);
				expect(count).toBeLessThanOrEqual(5);
			}
			expect(makeMatchPairsChallenge(plenty.slice(0, 3), () => 0.5)).toBeUndefined();
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
		const index = knownTermIndex({ ...args, wants: [], knownItems: homographs });

		expect(index.get('长 (cháng)')).toBe('chang');
		expect(index.get('长 (zhǎng)')).toBe('zhang');
	});

	it('resolves a bare citation of an ambiguous term to the first card, always', () => {
		const index = knownTermIndex({ ...args, wants: [], knownItems: homographs });
		const flipped = knownTermIndex({
			...args,
			wants: [],
			knownItems: [...homographs].reverse()
		});

		expect(index.get('长')).toBe('chang');
		expect(flipped.get('长')).toBe('zhang');
	});

	it('lets a wanted word keep the bare key: the batch is about it', () => {
		const index = knownTermIndex({
			...args,
			wants: [want({ id: 'due', term: '长', meaning: 'to grow' }, { type: 'recognize-mc' })],
			knownItems: homographs
		});

		expect(index.get('长')).toBe('due');
		expect(index.get('长 (zhǎng)')).toBe('zhang');
	});
});
