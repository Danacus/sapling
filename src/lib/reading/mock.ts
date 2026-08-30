/**
 * Offline reading mode: no key, no network, no model — but the real parsers.
 *
 * The same bargain `$lib/llm/mock` and `$lib/conversation/mock` strike. The
 * fixtures below are written in the wire format, emitted as a fenced JSON string
 * and fed to {@link parseGeneratedText} / {@link parseAnnotatedText}, so
 * developing the reader with no API key exercises the production parse path
 * rather than a parallel happy one — fence stripping, zod, the `null`-to-absent
 * normalization and the alignment check all included.
 *
 * Two fixture sets, picked by the target language exactly as the lesson mock
 * picks its own (`usesMandarinFixtures`), and deliberately the same restaurant
 * corner of daily life so the two modes look like one app:
 *
 * - **Spanish for English speakers** (the default), `"reading": null`
 *   throughout, as a Latin-script text has.
 * - **Mandarin for English speakers**, with pinyin on every sentence and a
 *   glossary that lists the words the segmenter needs — which is what makes the
 *   ruby rendering and the tap targets developable with no key at all.
 *
 * The annotate mock is different in kind: there are no canned sentences, because
 * the learner pasted their own. It annotates whatever it is given — a placeholder
 * translation per line, no readings, and a glossary built from the first few
 * distinct words of the text — which is enough to exercise the reader's
 * alignment, its word cards and its segmentation.
 */

import { usesMandarinFixtures } from '$lib/llm';
import { isPunctuationOnly } from '$lib/text';
import { annotatedSentences, parseAnnotatedText, resolveTitle } from './annotate-call';
import type { AnnotateTextArgs } from './annotate-call';
import { parseGeneratedText } from './generate';
import type { GenerateTextArgs } from './generate';
import type { ReadingTextDraft } from './schemas';
import { tokenizeByTerms, wordKey } from './tokenize';

/** How many words of a pasted text the offline annotator bothers to gloss. */
export const MOCK_GLOSSARY_WORDS = 5;

/** The canned Spanish text, in the wire format, fenced as a real reply arrives. */
const SPANISH_TEXT = {
	title: 'Una mesa para dos',
	sentences: [
		{
			text: 'El sábado por la tarde fuimos al restaurante de la esquina.',
			reading: null,
			translation: 'On Saturday afternoon we went to the restaurant on the corner.'
		},
		{
			text: '—¿Tienen una mesa para dos? —preguntó mi hermana.',
			reading: null,
			translation: '"Do you have a table for two?" my sister asked.'
		},
		{
			text: 'El camarero nos llevó a una mesa junto a la ventana.',
			reading: null,
			translation: 'The waiter took us to a table by the window.'
		},
		{
			text: 'Yo pedí sopa y ella pidió pescado con arroz.',
			reading: null,
			translation: 'I ordered soup and she ordered fish with rice.'
		},
		{
			text: 'La cuenta no era cara, así que dejamos una propina.',
			reading: null,
			translation: 'The bill was not expensive, so we left a tip.'
		},
		{
			text: 'Volveremos el próximo sábado, seguro.',
			reading: null,
			translation: 'We will be back next Saturday, for sure.'
		}
	],
	glossary: [
		{ term: 'camarero', reading: null, meaning: 'waiter' },
		{ term: 'propina', reading: null, meaning: 'tip' },
		{ term: 'cuenta', reading: null, meaning: 'the bill' },
		{ term: 'esquina', reading: null, meaning: 'corner' },
		{ term: 'pescado', reading: null, meaning: 'fish (to eat)' }
	]
};

/**
 * The canned Mandarin text. Its glossary lists every word of the piece, not just
 * the hard ones — the rule the prompt states for unspaced scripts, so the mock
 * segments the way a paid text does.
 */
const MANDARIN_TEXT = {
	title: '一张两个人的桌子',
	sentences: [
		{
			text: '星期六下午我们去了路口的饭馆。',
			reading: 'xīng qī liù xià wǔ wǒ men qù le lù kǒu de fàn guǎn.',
			translation: 'On Saturday afternoon we went to the restaurant on the corner.'
		},
		{
			text: '姐姐问：“有两个人的桌子吗？”',
			reading: 'jiě jie wèn: "yǒu liǎng gè rén de zhuō zi ma?"',
			translation: 'My sister asked: "Do you have a table for two?"'
		},
		{
			text: '服务员带我们到窗边的桌子。',
			reading: 'fú wù yuán dài wǒ men dào chuāng biān de zhuō zi.',
			translation: 'The waiter took us to a table by the window.'
		},
		{
			text: '我点了汤，她点了鱼和米饭。',
			reading: 'wǒ diǎn le tāng, tā diǎn le yú hé mǐ fàn.',
			translation: 'I ordered soup, and she ordered fish and rice.'
		},
		{
			text: '买单的时候不太贵。',
			reading: 'mǎi dān de shí hòu bú tài guì.',
			translation: 'When we paid, it was not too expensive.'
		},
		{
			text: '下个星期六我们还要来。',
			reading: 'xià gè xīng qī liù wǒ men hái yào lái.',
			translation: 'Next Saturday we will come again.'
		}
	],
	glossary: [
		{ term: '饭馆', reading: 'fàn guǎn', meaning: 'restaurant' },
		{ term: '服务员', reading: 'fú wù yuán', meaning: 'waiter' },
		{ term: '桌子', reading: 'zhuō zi', meaning: 'table' },
		{ term: '买单', reading: 'mǎi dān', meaning: 'to pay the bill' },
		{ term: '米饭', reading: 'mǐ fàn', meaning: 'cooked rice' },
		{ term: '星期六', reading: 'xīng qī liù', meaning: 'Saturday' }
	]
};

/** As a real completion arrives: fenced, so the mock exercises `stripFences` too. */
function fenced(payload: unknown): string {
	return '```json\n' + JSON.stringify(payload) + '\n```';
}

/**
 * One canned text, offline. Deterministic: the same profile always yields the
 * same piece, with the learner's topic noted in the title when they named one.
 */
export async function mockGeneratedText(args: GenerateTextArgs): Promise<ReadingTextDraft> {
	const fixture = usesMandarinFixtures(args.profile.targetLanguage) ? MANDARIN_TEXT : SPANISH_TEXT;
	const topic = args.topic?.trim();

	return parseGeneratedText(
		fenced(topic ? { ...fixture, title: `${fixture.title} (${topic})` } : fixture)
	);
}

/**
 * The first few distinct words of the text, as a stand-in glossary.
 *
 * Built with the real {@link tokenizeByTerms}, so an unspaced text yields
 * characters and a spaced one yields words — the same split the reader will make
 * of it, which is what makes the offline glossary actually land on tokens.
 */
function mockGlossary(sentences: readonly string[]): { term: string; meaning: string }[] {
	const seen = new Set<string>();
	const out: { term: string; meaning: string }[] = [];

	for (const sentence of sentences) {
		for (const token of tokenizeByTerms(sentence)) {
			const term = token.text.trim();
			if (!term || isPunctuationOnly(term)) continue;
			const key = wordKey(term);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push({ term, meaning: `(meaning of "${term}")` });
			if (out.length >= MOCK_GLOSSARY_WORDS) return out;
		}
	}
	return out;
}

/**
 * Annotates the learner's own text, offline.
 *
 * Goes through the real parser with the real alignment check, so the placeholder
 * translations land under the right lines and a reader built against this mock
 * is a reader that works against a paid call.
 */
export async function mockAnnotatedText(args: AnnotateTextArgs): Promise<ReadingTextDraft> {
	const payload = {
		// `null` when the learner named it themselves or left it blank: a mock has
		// nothing to add, and `resolveTitle` already knows both fallbacks.
		title: null,
		sentences: args.sentences.map((_, i) => ({
			reading: null,
			translation: `(translation of sentence ${i + 1})`
		})),
		glossary: mockGlossary(args.sentences).map((entry) => ({ ...entry, reading: null }))
	};

	const parsed = parseAnnotatedText(fenced(payload), args.sentences.length);
	return {
		title: resolveTitle(args, parsed),
		sentences: annotatedSentences(args.sentences, parsed),
		glossary: parsed.glossary
	};
}
