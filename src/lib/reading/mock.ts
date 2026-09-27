/**
 * Offline reading mode: no key, no network, no model — but the real parsers.
 *
 * The same bargain `$lib/llm/mock` and `$lib/conversation/mock` strike. The
 * fixtures below are written in the wire format, emitted as a fenced JSON string
 * and fed to {@link parseGeneratedText} / {@link parseLookedUpWord} /
 * {@link parseLineTranslation}, so
 * developing the reader with no API key exercises the production parse path
 * rather than a parallel happy one — fence stripping, zod and the
 * `null`-to-absent normalization included.
 *
 * Two fixture texts, picked by the target language exactly as the lesson mock
 * picks its own (`usesMandarinFixtures`), and deliberately the same restaurant
 * corner of daily life so the two modes look like one app: **Spanish** (the
 * default) and **Mandarin**, whose per-word pinyin comes from `$lib/romanize`
 * in the reader like any other Chinese text's. The lookup and translate mocks
 * work on the one word or line they are handed.
 */

import { usesMandarinFixtures } from '$lib/llm';
import { parseGeneratedText } from './generate';
import type { GenerateTextArgs } from './generate';
import { parseLookedUpWord } from './lookup-call';
import type { LookupWordArgs } from './lookup-call';
import { parseLineTranslation } from './translate-call';
import type { TranslateLineArgs } from './translate-call';
import type { GlossEntry, ReadingTextDraft } from './schemas';

/** The canned Spanish text, in the wire format, fenced as a real reply arrives. */
const SPANISH_TEXT = {
	title: 'Una mesa para dos',
	paragraphs: [
		'El sábado por la tarde fuimos al restaurante de la esquina.',
		'—¿Tienen una mesa para dos? —preguntó mi hermana.',
		'El camarero nos llevó a una mesa junto a la ventana. Yo pedí sopa y ella pidió pescado con arroz. La cuenta no era cara, así que dejamos una propina.',
		'Volveremos el próximo sábado, seguro.'
	]
};

/** The canned Mandarin text. */
const MANDARIN_TEXT = {
	title: '一张两个人的桌子',
	paragraphs: [
		'星期六下午我们去了路口的饭馆。',
		'姐姐问：“有两个人的桌子吗？”',
		'服务员带我们到窗边的桌子。我点了汤，她点了鱼和米饭。买单的时候不太贵。',
		'下个星期六我们还要来。'
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
 * One word explained, offline. Through the real parser, so the echoed term and
 * the `null`-to-absent reading are the production ones.
 */
export async function mockLookedUpWord(args: LookupWordArgs): Promise<GlossEntry> {
	const term = args.term.trim();
	return parseLookedUpWord(
		fenced({
			term,
			reading: null,
			meaning: `(meaning of "${term}")`,
			explanation: ` (how "${term}" is used in this sentence) `
		}),
		term
	);
}

/**
 * One line translated, offline — through the real parser, so a mock reader
 * shows a translation where a paid one would and the trimming is production's.
 */
export async function mockLineTranslation(args: TranslateLineArgs): Promise<string> {
	return parseLineTranslation(fenced({ translation: ` (translation of "${args.text.trim()}") ` }));
}
