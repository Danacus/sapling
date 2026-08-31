<!--
  The reader: one stored text, a page at a time, with every word one tap from its
  meaning.

  The text itself is immutable — the sentences, the readings and the glossary are
  what the model wrote the day it was made. Everything the learner *sees* is
  decided here on every open, by `annotateSentence` against the garden and the
  marks as they stand today, which is why a text written last month shows this
  month's knowledge. The roll map that decides which tracked readings fade is
  created once per component instance and kept across re-annotations, so a word
  reads the same in sentence two and sentence nine — which is also why `lines`
  stays the annotation of the *whole* text and only the rendering is paged.

  Pages are `paginate`'s ranges over those sentences and the current one is
  `?p=` in the URL, clamped. Nothing about the position is stored: a text
  reopened from the library starts at page 1, deliberately, because a stored
  bookmark is a fact to sync and a page is cheap to skip past.

  A text imported from subtitles with a recording attached opens in the **follow
  view** instead, and it is a view rather than a route because everything below
  is the same: the same annotation of the same whole text, the same whole-text
  `selected`, the same card. Only the page is different — in follow view *the
  page is the current sentence*, `pageRange` cut from the clock rather than from
  `paginate`, so the translation, the stored reading and Listen all follow the
  line being spoken without a word of it knowing about a video. `?view=text` is
  the way back to the paged reader.

  **The clock turns no grades.** Page grading is the learner saying "I have read
  this", and a video that keeps playing while they look out of the window says
  nothing at all — so the finish row, the `Good`s and the receipt belong to the
  paged view only. What a *tap* means is unchanged, because a tap is still real:
  a lookup on a garden word is still `Again`, in either view.

  This page owns every write. `$lib/reading` never touches the database: it is
  handed the vocabulary and hands back words, and adding, marking and looking up
  all happen here through the repositories — which is what puts them in the sync
  log for free. Reading is also review, scoped to the page: a lookup on a garden
  word is `Again` and confirming the page is `Good` for the rest of its garden
  words — both governed by the grade the word last got *today*, read back out of
  the item's own `recentGrades` rather than held in a set here, so the state
  survives a reload and agrees with the drill.

  The card offers what the word's status leaves open: a tracked word only its
  bed, a known one Unmark, and everything else "Add to my words" and "I know
  this" — plus, on a word nobody has glossed, a typed meaning or **Look it up**,
  the one paid call the reader makes. Its answer lands in `extraGlossary`, which
  is merged into the annotate context, so the word turns `new` for the rest of
  this open; it is not stored, because the text is immutable and what is worth
  keeping is the word the learner then adds.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	import { addWordsTool, defaultToolContext } from '$lib/assistant/tools';
	import {
		deleteText,
		getAllItems,
		getKnownTerms,
		getProfile,
		getText,
		localDay,
		markWord,
		recordLookup,
		updateItemAfterReview
	} from '$lib/db';
	import {
		crossedEnd,
		firstTimed,
		nextTimed,
		objectUrl,
		prevTimed,
		rememberFile,
		sentenceAt,
		sentenceRangeAt,
		startOf,
		takeFile,
		videoPlayer,
		youtubePlayer
	} from '$lib/media';
	import type { Player } from '$lib/media';
	import {
		annotateSentence,
		lookUpWord,
		paginate,
		showSentenceReading,
		tokenizeByTerms,
		wordKey
	} from '$lib/reading';
	import type { AnnotateContext, ReadingWord, TokenizeFn } from '$lib/reading';
	import { hasLocalRomanizer, loadRomanizer } from '$lib/romanize';
	import type { Maturity } from '$lib/session/progression';
	import { Grade, newCardState, reviewCard, type FsrsCardState } from '$lib/srs';
	import { cardKey, joinTokens, usesInterWordSpaces } from '$lib/text';
	import { speak, stopSpeaking, ttsAvailable, warmSpeech } from '$lib/tts';
	import type { GlossEntry, KnowledgeItem, Profile, ReadingText } from '$lib/types';
	import { getRomanizationMode } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	/** The garden's own bed names, so one word means one thing across the app. */
	const BEDS: Record<Maturity, string> = { new: 'sprouting', young: 'growing', solid: 'rooted' };

	let loading = $state(true);
	let loadError = $state('');
	/** The text is not here — deleted on this device or on another one. */
	let missing = $state(false);
	let profile = $state<Profile | undefined>(undefined);
	let text = $state<ReadingText | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let knownTerms = $state<string[]>([]);

	/**
	 * The romanizer's tokenizer once its lazy chunk lands, `tokenizeByTerms`
	 * until then and for every language that has none. Both produce the same
	 * token shape; only one of them brings readings.
	 */
	let tokenize = $state<TokenizeFn>(tokenizeByTerms);

	/**
	 * One adaptive roll per card, for the whole time this text is open — keyed by
	 * `cardKey` inside the annotator, so two cards sharing a spelling fade on
	 * their own schedules. A plain `Map`, deliberately not `$state`: the
	 * annotator writes to it while a `$derived` is computing, and a reactive
	 * cache would turn that into a loop.
	 */
	const rolls = new Map<string, boolean>();
	/**
	 * Words looked up from the card, on top of the text's own glossary — for this
	 * open only.
	 *
	 * A text is immutable, so a lookup cannot be written into its glossary; but a
	 * word the model missed is `plain` everywhere it appears, and answering it
	 * once should answer it everywhere. So the answers live here and are merged
	 * into the annotate context, which turns the word `new` — underline, gloss,
	 * and "Add to my words" filled in from the meaning — for the rest of the
	 * session. Nothing is lost by not persisting it: if the word mattered, the
	 * learner adds it, and *that* is a fact worth syncing.
	 */
	let extraGlossary = $state<GlossEntry[]>([]);
	/** Read once — the setting lives in Settings, not mid-text. */
	const mode = getRomanizationMode();
	let now = $state(Date.now());

	/** Which word's card is open, by position — so a write refreshes it in place. */
	let selected = $state<{ line: number; word: number } | null>(null);
	/** The whole-text translation and the stored reading are each one decision. */
	let showTranslation = $state(false);
	let showReading = $state(false);
	/** The meaning typed for a word nobody has glossed. */
	let meaningDraft = $state('');
	let writing = $state(false);
	/** A lookup in flight. Its own flag, because it is the card's only paid wait. */
	let lookingUp = $state(false);
	let cardError = $state('');
	let pageError = $state('');
	let playing = $state(false);
	/**
	 * What the side panel shows when no word is open: a confirmation. One slot
	 * for every card the page has — the word, "finished?", "delete?" — so a
	 * confirmation never reshapes the header or lands above the text, and it
	 * arrives where the eye already looks for a card (facing page on a desk,
	 * sheet at the foot of a phone).
	 */
	let panel = $state<'finish' | 'delete' | null>(null);

	/* The follow view ------------------------------------------------------- */

	/**
	 * The recording, once the learner has handed it over.
	 *
	 * A `File` and never anything more permanent: what the store holds is the
	 * *name*, so the file is either still in `$lib/media`'s session cache from the
	 * import a moment ago or it is picked again here. Held rather than re-read,
	 * because a video is hundreds of megabytes and the app touches none of it.
	 */
	let mediaFile = $state<File | undefined>(undefined);
	/** The object URL for {@link mediaFile}, revoked on every replacement and on destroy. */
	let mediaSrc = $state('');
	let videoEl = $state<HTMLVideoElement | null>(null);
	/**
	 * The box YouTube's iframe is built inside — a plain `<div>`, because the API
	 * replaces whatever element it is handed and a Svelte-owned node swapped out
	 * from underneath Svelte is a bug waiting for the next re-render.
	 * `$lib/media`'s `youtubePlayer` puts its own child in here and owns it.
	 */
	let frameEl = $state<HTMLDivElement | null>(null);
	/**
	 * The player could not be loaded — offline, or blocked. One line in the
	 * video's place and the text is still there: "Read as text" is the answer, and
	 * it is already in the transport under it.
	 */
	let mediaError = $state('');
	let player: Player | undefined;
	/** Where the recording is, in milliseconds — the only thing the clock feeds in. */
	let currentMs = $state(0);
	/** Mirrors the element's own paused flag, so the button can say which it is. */
	let mediaPaused = $state(true);
	/**
	 * The previous sample, kept outside `$state` on purpose: it exists only to ask
	 * `crossedEnd` whether a boundary fell between two ticks, and nothing renders
	 * it.
	 */
	let lastMs = 0;
	/**
	 * Stop at the end of every line. Off by default and not remembered: it turns
	 * a video into a drill, which is a mood rather than a setting.
	 */
	let autoPause = $state(false);
	/** Whether the viewport is wide enough for the transcript to have a page of its own. */
	let wide = $state(false);
	/**
	 * The rendered width of the picture, measured rather than computed.
	 *
	 * In the wide layout the video is sized from its *height* — it takes the room
	 * left after the line and the controls, and its aspect ratio decides the rest
	 * — so no stylesheet can know how wide it came out. `bind:clientWidth` is a
	 * `ResizeObserver` underneath, and the number becomes `--film-width` on the
	 * column so the caption under the picture can match it.
	 *
	 * One per thing that can stand in the stage — the video, the picker that waits
	 * for a file, YouTube's iframe — because a binding shared between two branches
	 * is zeroed by whichever of them unmounts last, and the caption should sit
	 * under all three the same way.
	 */
	let filmWidth = $state(0);
	let pickWidth = $state(0);
	let frameWidth = $state(0);

	/**
	 * Words tapped on *this page*, by key — cleared whenever the page turns.
	 *
	 * Page-scoped on purpose: a word looked up on page one and then read fine on
	 * page three is exactly the re-encounter reading mode is for, and the `Again`
	 * put its card into relearning, so the later `Good` is what graduates it. What
	 * stops the same word collecting a `Good` on every page is not this set but
	 * the grade it already carries today.
	 */
	const tapped = new SvelteSet<string>();
	/** Every word tapped while this text was open, by key — a tapped word was not known. */
	const lookedUp = new SvelteSet<string>();
	/** Set once Finished has written; the panel then shows the receipt. */
	let finished = $state(false);
	let summary = $state('');
	/**
	 * Whether Finished also marks the un-tapped `new` words known. Off by default
	 * and never remembered: a word becoming "known" because the learner did not
	 * happen to tap it is LingQ's most-resented mechanic, so here it is a box
	 * ticked on purpose, every time.
	 */
	let markFresh = $state(false);

	const lang = $derived(profile?.targetLanguage ?? '');

	const ctx: AnnotateContext = $derived({
		items,
		knownTerms,
		// The text's own glossary plus whatever was looked up since it opened. The
		// annotator cannot tell the two apart, which is the point: a looked-up word
		// is `new` exactly like a glossed one, everywhere it appears.
		glossary: [...(text?.glossary ?? []), ...extraGlossary],
		mode,
		now,
		rolls
	});

	/** The stored sentences: what the clock is indexed against, and what pages are cut from. */
	const sentences = $derived(text?.sentences ?? []);

	/** The whole text, annotated. Re-runs whenever the vocabulary or the marks move. */
	const lines = $derived(
		sentences.map((sentence) => ({
			sentence,
			words: annotateSentence(sentence.text, tokenize, ctx)
		}))
	);

	/**
	 * Whether this text has a recording the reader can follow.
	 *
	 * A media of either kind — both are playable now, and which one it is decides
	 * nothing beyond what gets mounted in the stage — and at least one timed
	 * sentence, because a player with nothing to highlight is a video in the wrong
	 * app.
	 */
	const followable = $derived(text?.media !== undefined && firstTimed(sentences) >= 0);

	/** Which player the stage builds. The only place in the page that asks. */
	const isYouTube = $derived(text?.media?.kind === 'youtube');
	const videoId = $derived(text?.media?.kind === 'youtube' ? text.media.videoId : '');

	/**
	 * Which view, from `?view=`. Follow is the default for a text that can follow:
	 * a learner who attached a recording attached it to watch it, and the paged
	 * reader is one press away.
	 */
	const following = $derived(followable && page.url.searchParams.get('view') !== 'text');

	/**
	 * The line being spoken, or `-1` before the first cue and in the paged view.
	 *
	 * Everything about *which* line is `$lib/media/follow`'s, which is pure: this
	 * is only the clock reading it is asked about.
	 */
	const currentIndex = $derived(following ? sentenceAt(sentences, currentMs) : -1);
	const currentRange = $derived(
		following ? sentenceRangeAt(sentences, currentMs) : { start: 0, end: 0 }
	);
	const prevIndex = $derived(prevTimed(sentences, currentRange.start));
	/** From `-1` this is the first timed line, which is what "next" means before the first cue. */
	const nextIndex = $derived(nextTimed(sentences, currentRange.end - 1));

	/** What to ask for by name when the file is not in hand. */
	const mediaName = $derived(text?.media?.kind === 'file' ? text.media.name : '');

	/**
	 * Whether there is something to press the line controls against.
	 *
	 * For a file that means the learner has handed one over; for YouTube it means
	 * the API turned up. Both fail into the same shape — the transport greys out,
	 * the text stays readable, "Read as text" still works.
	 */
	const playable = $derived(isYouTube ? mediaError === '' : mediaSrc !== '');

	/** Whichever of the three is in the stage. Rounded — a subpixel width is noise here. */
	const captionWidth = $derived(
		Math.round(isYouTube ? frameWidth : mediaSrc ? filmWidth : pickWidth)
	);

	/**
	 * Where the pages break. Derived from the stored sentences, never from the
	 * annotation: a break must not move because the learner added a word.
	 */
	const pages = $derived(paginate(sentences));
	/** One page even for a text with no sentences, so the reader always has a frame. */
	const pageCount = $derived(Math.max(1, pages.length));

	/**
	 * Which page, from `?p=` — 1-based in the URL because that is what the label
	 * says, and clamped rather than 404'd: a stale link to page 9 of a text that
	 * now has 3 lands on the last page, which is where "read to the end" means.
	 */
	const pageIndex = $derived.by(() => {
		const asked = Number(page.url.searchParams.get('p') ?? '1');
		if (!Number.isFinite(asked)) return 0;
		return Math.min(Math.max(Math.trunc(asked) - 1, 0), pageCount - 1);
	});
	/**
	 * What is on screen, as a range of sentences — and the whole of the difference
	 * between the two views.
	 *
	 * Following, the page *is* the current line, so everything downstream that was
	 * written for a page (the translation, the stored reading, Listen, and the
	 * whole-text indices the word buttons carry) follows the clock with no idea
	 * that it is doing so. Before the first cue the range is empty, which is the
	 * honest answer: nothing is being spoken yet.
	 */
	const pageRange = $derived(following ? currentRange : (pages[pageIndex] ?? { start: 0, end: 0 }));
	const lastPage = $derived(pageIndex >= pageCount - 1);

	/** The slice of the annotated text this page shows — the only part rendered. */
	const pageLines = $derived(lines.slice(pageRange.start, pageRange.end));

	/**
	 * What sits between two sentences on the page: the script's own rule, decided
	 * from the whole text — a space for Spanish, nothing for Chinese. Whole text
	 * rather than page, so a page of dialogue does not space differently from the
	 * one before it.
	 */
	const gap = $derived(
		usesInterWordSpaces(lines.map((line) => line.sentence.text).join('')) ? ' ' : ''
	);

	/** True once the romanizer's tokenizer is in — every reading is then ruby. */
	const localReadings = $derived(tokenize !== tokenizeByTerms);

	/** The page's translation, not the text's: it sits under the page it explains. */
	const translation = $derived(
		joinTokens(pageLines.map((line) => line.sentence.translation ?? '').filter(Boolean))
	);

	/**
	 * The stored, sentence-wide readings as one block: the fallback for a language
	 * with no local romanizer. Never offered beside ruby — that would print every
	 * reading twice — and never under `'off'`.
	 */
	const storedReading = $derived(
		localReadings || mode === 'off'
			? ''
			: joinTokens(
					pageLines
						.filter((line) => line.sentence.reading && showSentenceReading(line.words, mode))
						.map((line) => line.sentence.reading ?? '')
				)
	);

	/**
	 * The open word, read back out of `lines` rather than captured on tap: after a
	 * write the text re-annotates and the card has to show the *new* status, not
	 * the one that was true when it was opened.
	 */
	const card = $derived(selected ? (lines[selected.line]?.words[selected.word] ?? null) : null);

	/**
	 * Whether the panel is holding anything — a word card, or a confirmation.
	 *
	 * One predicate because three things turn on it and they must agree: the panel
	 * itself, the transcript it displaces at ≥48rem, and the scroll room the
	 * column reserves under the sheet on a phone.
	 */
	const panelOpen = $derived(card !== null || panel !== null);

	/**
	 * The reading shown on the card.
	 *
	 * The token's first — a local romanizer knows this occurrence's reading, and
	 * the glossary only knows the term's. Unlike the prose it ignores the fading
	 * rule: opening a card is the learner asking to have this word explained, and
	 * an answer with a piece held back is not an answer.
	 */
	const cardReading = $derived(card?.reading ?? card?.gloss?.reading ?? '');

	/** What "Add to my words" would file — the gloss, or what the learner typed. */
	const draftMeaning = $derived((card?.gloss?.meaning ?? meaningDraft).trim());

	/**
	 * Whether the facing page shows the transcript: following, wide enough for a
	 * facing page to exist, and nothing else claiming the slot. The card and the
	 * confirmations *replace* it — one panel, whatever is in it.
	 */
	const showTranscript = $derived(following && wide && !panelOpen);

	/**
	 * The grade each garden word last got *today*, by item id — the whole of this
	 * page's review state, derived rather than kept.
	 *
	 * `recentGrades` is oldest-first and the ledger is what everything else reads,
	 * so taking the last entry of the day here means a lapse in this morning's
	 * drill and a lookup in this text are the same fact: reading a word you
	 * already failed today is not a second failure, and a word that appears on
	 * five pages cannot collect five `Good`s. It also survives a reload, which the
	 * set it replaces did not. `now` moves on every `refresh()`, so a session held
	 * open across midnight rolls over on the next write.
	 */
	const gradedToday = $derived.by(() => {
		const today = localDay(now);
		const out = new Map<string, number>();
		for (const item of items) {
			const last = item.recentGrades?.at(-1);
			if (last && localDay(last.at) === today) out.set(item.id, last.grade);
		}
		return out;
	});

	/** True for a garden word already counted as forgotten today, wherever that happened. */
	function isLapsed(word: ReadingWord): boolean {
		return word.itemId !== undefined && gradedToday.get(word.itemId) === Grade.Again;
	}

	$effect(() => {
		if (!browser) return;

		const id = page.params.id ?? '';
		let cancelled = false;
		loading = true;
		loadError = '';
		missing = false;

		// `withRecentGrades`: the page's whole review state is folded out of the
		// last grade each word got today, so the entries have to come along.
		Promise.all([
			getProfile(),
			getText(id),
			getAllItems({ withRecentGrades: true }),
			getKnownTerms()
		])
			.then(([loadedProfile, loadedText, loadedItems, known]) => {
				if (cancelled) return;
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
				if (!loadedProfile) return;

				profile = loadedProfile;
				items = loadedItems;
				knownTerms = known;
				now = Date.now();
				loading = false;

				if (!loadedText) {
					missing = true;
					return;
				}
				text = loadedText;
				// The file the composer was just given, if this is the open straight
				// after an import. On every later open it is `undefined` and the video
				// slot shows the picker instead — a recording is never stored, only
				// its name.
				mediaFile = takeFile(loadedText.id);

				if (!hasLocalRomanizer(loadedProfile.targetLanguage)) return;
				// A lazy chunk (pinyin's dictionary is not small), so the text renders
				// with the fallback tokenizer immediately and re-renders with real
				// per-word readings when it lands. A failed fetch simply leaves the
				// fallback in place — readings are a nicety, the text is not.
				void loadRomanizer(loadedProfile.targetLanguage)
					.then((romanizer) => {
						if (cancelled || !romanizer) return;
						tokenize = (source, terms) => romanizer.tokenize(source, terms);
					})
					.catch(() => undefined);
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open that text.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/** Nothing keeps speaking into a page the learner has left. */
	$effect(() => () => {
		playing = false;
		stopSpeaking();
	});

	/**
	 * The object URL for whatever file is in hand.
	 *
	 * An object URL pins the file until it is revoked, so the revoke is the
	 * cleanup of the same effect that made it: every replacement and every
	 * teardown lets the previous one go, and a learner who tries three files does
	 * not end up holding three videos.
	 */
	$effect(() => {
		const file = mediaFile;
		if (!file) {
			mediaSrc = '';
			return;
		}
		const { url, revoke } = objectUrl(file);
		mediaSrc = url;
		return () => {
			mediaSrc = '';
			revoke();
		};
	});

	/**
	 * The player, for as long as there is an element to build it on.
	 *
	 * Two implementations and one piece of wiring: whichever element is in the
	 * stage decides which is built, and nothing below this line knows which it
	 * got — that is what `Player` is for, and it is why the second kind of
	 * recording was a new file rather than a rewrite of this page.
	 *
	 * Everything that could be wrong about following the clock is in
	 * `$lib/media/follow`, which is pure; this is only the wiring. `lastMs` is
	 * what makes auto-pause fire *once*: the end of a line falls between two
	 * samples exactly one time, whereas "is the clock past the end" is true for
	 * every sample until the next line starts and would pause again the instant
	 * the learner pressed play.
	 */
	$effect(() => {
		const el = videoEl;
		const frame = frameEl;
		const id = videoId;

		const built = el
			? videoPlayer(el)
			: frame && id
				? // The failure is asynchronous (a script that never lands) and lands
					// in `mediaError`, which unmounts this very element — so the effect
					// re-runs, finds nothing to build on, and stops. No loop, because
					// the error branch has no element in it.
					youtubePlayer(frame, id, { onFail: (message) => (mediaError = message) })
				: undefined;
		if (!built) return;

		player = built;
		lastMs = built.currentTime();

		// `untrack`, because `onTime` calls back **synchronously** on subscribe and
		// the reads inside would otherwise become dependencies of this effect —
		// which would tear the player down and build a new one every time the
		// auto-pause box was ticked. The element is the only thing this effect is
		// about.
		const stop = built.onTime((ms) =>
			untrack(() => {
				const before = lastMs;
				lastMs = ms;
				currentMs = ms;
				mediaPaused = built.paused();

				if (!autoPause || built.paused()) return;
				// The line that was running at the previous sample: at the moment of a
				// crossing the next one has not started, so this is still the line
				// whose end was just passed.
				const running = sentenceAt(sentences, before);
				if (running >= 0 && crossedEnd(sentences, running, before, ms)) built.pause();
			})
		);

		return () => {
			stop();
			built.destroy();
			if (player === built) player = undefined;
		};
	});

	/**
	 * Whether the spread is open, asked of the viewport rather than of CSS.
	 *
	 * The transcript is a list of every sentence in the text, and hiding a
	 * thousand buttons with `display: none` still builds a thousand buttons. So
	 * the phone does not render it at all, and the same 48rem the stylesheet uses
	 * is repeated here — as `layout.md` says it must be, since a custom property
	 * cannot be read from a media query.
	 */
	$effect(() => {
		if (!browser) return;
		const query = window.matchMedia('(min-width: 48rem)');
		const sync = () => (wide = query.matches);
		sync();
		query.addEventListener('change', sync);
		return () => query.removeEventListener('change', sync);
	});

	/**
	 * Keeps the transcript's current line in view.
	 *
	 * `block: 'nearest'` so a line already on screen is left where it is — the
	 * transcript scrolls under the reader's eye rather than yanking the current
	 * line to the middle every few seconds.
	 */
	const transcriptRows: (HTMLElement | null)[] = [];
	$effect(() => {
		if (currentRange.start < currentRange.end) {
			transcriptRows[currentRange.start]?.scrollIntoView({ block: 'nearest' });
		}
	});

	/** The file, chosen again on an open that did not inherit it. */
	function chooseMedia(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !text) return;
		// The stored name is not checked against this one: a learner who renamed or
		// re-encoded the file still means this recording, and refusing it would be
		// the app being certain about the one thing it deliberately did not keep.
		mediaFile = file;
		// So a second open in this session does not ask again.
		rememberFile(text.id, file);
	}

	/** Play, or pause — the one control the native bar also offers, kept for the keyboard. */
	function toggleMedia() {
		if (!player) return;
		if (player.paused()) player.play();
		else player.pause();
		mediaPaused = player.paused();
	}

	/**
	 * Puts the clock at the start of sentence `i`.
	 *
	 * `currentMs` is set here as well as awaited from the player, because a seek
	 * on a paused element still takes a turn of the event loop to report back and
	 * the highlight should move under the finger, not after it.
	 */
	function seekTo(i: number, andPlay = false) {
		const at = startOf(sentences, i);
		if (!player || at === undefined) return;
		player.seek(at);
		lastMs = at;
		currentMs = at;
		if (andPlay) player.play();
		mediaPaused = player.paused();
	}

	/** Replay the line: back to its start, playing. From nowhere, the first line. */
	function replayLine() {
		seekTo(currentIndex >= 0 ? currentIndex : firstTimed(sentences), true);
	}

	/** Switches between the follow view and the paged reader, in the URL. */
	async function setView(next: 'follow' | 'text') {
		const url = new URL(page.url);
		// Coming back to the video is also the retry: the failure was a script that
		// did not arrive, `$lib/media` forgets a failed load, and asking again is
		// what a learner who has just reconnected would expect this button to do.
		if (next === 'follow') {
			mediaError = '';
			url.searchParams.delete('view');
		} else url.searchParams.set('view', 'text');
		// The page number belongs to the paged view; leaving it behind would put
		// the learner on page 4 of a text they were watching from the top.
		url.searchParams.delete('p');
		await goto(url, { replaceState: true, noScroll: true });
	}

	/**
	 * Turning a page resets everything scoped to one: what was tapped, the
	 * checkbox, the receipt, whatever the panel held. Keyed on `pageIndex` alone,
	 * so a typed or restored `?p=` resets exactly as the buttons do — the page is
	 * the state, and the URL is where it lives.
	 */
	$effect(() => {
		void pageIndex;
		tapped.clear();
		markFresh = false;
		finished = false;
		summary = '';
		selected = null;
		panel = null;
		playing = false;
		stopSpeaking();
	});

	/**
	 * Re-reads what a write changed; the roll map survives, so nothing re-rolls.
	 *
	 * This is also how a grade becomes visible: the underlines and the status line
	 * read `recentGrades`, so every `review()` is followed by one of these.
	 */
	async function refresh() {
		const [loadedItems, known] = await Promise.all([
			getAllItems({ withRecentGrades: true }),
			getKnownTerms()
		]);
		items = loadedItems;
		knownTerms = known;
		now = Date.now();
	}

	function statusLine(word: ReadingWord): string {
		if (word.status === 'tracked' && isLapsed(word)) {
			return `Counted as forgotten · ${BEDS[word.maturity ?? 'new']}, back sooner`;
		}
		if (word.status === 'tracked') return `In your garden · ${BEDS[word.maturity ?? 'new']}`;
		if (word.status === 'known') return 'Marked known';
		if (word.status === 'new') return 'New word';
		return 'Not in your garden';
	}

	function close() {
		selected = null;
		panel = null;
	}

	/** Opens a confirmation in the panel, in place of whatever word was open. */
	function confirm(kind: 'finish' | 'delete') {
		selected = null;
		panel = kind;
	}

	/**
	 * Turns to a page, 1-based, by rewriting `?p=`.
	 *
	 * `replaceState` because paging is not somewhere to go *back* to — Back
	 * belongs to the library, and a ten-page text should not need ten presses to
	 * leave. `noScroll` because SvelteKit's restoration would land wherever this
	 * page was left; the new page starts at its own first line instead.
	 */
	async function turnTo(number: number) {
		const url = new URL(page.url);
		if (number <= 1) url.searchParams.delete('p');
		else url.searchParams.set('p', String(number));

		await goto(url, { replaceState: true, noScroll: true });
		window.scrollTo({ top: 0 });
	}

	function open(line: number, index: number) {
		const target = lines[line]?.words[index];
		if (!target?.key || !text) return;

		selected = { line, word: index };
		panel = null;
		meaningDraft = '';
		cardError = '';

		// A word tapped in a video that keeps running is a word the learner reads
		// while missing the next line. Stopping is what they would do themselves,
		// one beat later and having lost something.
		if (following) player?.pause();

		// A tap is a *lookup* — "I don't understand this, explain" — and it is the
		// one thing about a reading session that cannot be recovered afterwards.
		// Once per open, never awaited: a card must not wait on a write.
		void recordLookup(target.text, text.id, target.itemId);
		lookedUp.add(target.key);
		// Before the add, so a second tap on the same page is not a second grade:
		// `gradedToday` only catches up once the write has been read back.
		const again = target.status === 'tracked' && target.itemId && !tapped.has(target.key);
		tapped.add(target.key);

		// On a garden word the lookup is also a lapse: recall failed in context,
		// with the reading often showing — the easiest conditions there are — so
		// it is graded `Again`, once per *day* rather than once per text open: a
		// word already lost in this morning's drill is not lost twice. `add_words`
		// and the drill grade through the same repository call, so this lands in
		// the ledger as an ordinary review, amendable like any other.
		if (again && target.itemId && !isLapsed(target)) {
			void review(target.itemId, Grade.Again).then(refresh);
		}
	}

	/** One graded review, exactly as the session engine files one. */
	function review(itemId: string, grade: Grade): Promise<unknown> {
		const at = Date.now();
		return updateItemAfterReview(
			itemId,
			(stored) =>
				reviewCard((stored as FsrsCardState | null | undefined) ?? newCardState(at), grade, at),
			{ at, grade }
		);
	}

	/**
	 * What confirming this page would do — counted live, so the confirm step can
	 * say it. Over `pageLines` only: a page is the unit of reading and therefore
	 * the unit of grading, and the receipt is never totalled across pages.
	 */
	const finishPlan = $derived.by(() => {
		const read = new Map<string, string>();
		const looked = new Set<string>();
		const fresh = new Map<string, string>();
		for (const line of pageLines) {
			for (const word of line.words) {
				if (!word.key) continue;
				if (word.status === 'tracked' && word.itemId) {
					// Two separate reasons not to grade a word `Good` here: the learner
					// looked it up on this page, or it already has a `Good` today from
					// an earlier page or from the drill. `looked` is only the receipt's
					// count, so it names the words this page actually lost — a word
					// tapped and *added* here was never graded and is nobody's failure.
					if (tapped.has(word.key)) {
						if (gradedToday.get(word.itemId) === Grade.Again) looked.add(word.itemId);
					} else if (gradedToday.get(word.itemId) !== Grade.Good) {
						read.set(word.itemId, word.text);
					}
				} else if (word.status === 'new' && !lookedUp.has(word.key)) {
					// A tapped new word is one the learner needed explained — the last
					// thing to call known — and that stays true across the whole text,
					// not just this page.
					fresh.set(word.key, word.gloss?.term ?? word.text);
				}
			}
		}
		return { read: [...read.keys()], looked: [...looked], fresh: [...fresh.values()] };
	});

	/**
	 * What the whole read has counted so far, every page confirmed in this open
	 * added up — because the receipt appears once, on the last page, and
	 * "Finished · 0 garden words read fine" for a last page whose words were all
	 * graded on page one reads as failure when it is the opposite. Sets, so a
	 * word tapped on two pages is one lapse. Deliberately *not* reset by the
	 * page-turn effect: it is text-wide, and a plain object because nothing
	 * renders it until it is folded into `summary`.
	 */
	const counted = { read: new Set<string>(), looked: new Set<string>(), fresh: new Set<string>() };

	/**
	 * Confirming a page: the reading counted, then on to the next one.
	 *
	 * Not looking a garden word up is the implicit `Good` — recall in context —
	 * but only at this explicit moment, never by scrolling past. The `new` words
	 * read without a tap can be marked known too — LingQ's paging — but only
	 * with `markFresh` ticked for this press. `plain` words are left alone —
	 * unglossed, they are as likely to be a segmenter's slip as a word.
	 *
	 * On the last page this is "Finished reading" and the receipt takes the
	 * button's place; on any other it is "Next page" and the writing happens
	 * before the turn, so a page is graded exactly once, when it is left.
	 */
	async function finishPage() {
		if (!text || writing || finished) return;
		const { read, looked } = finishPlan;
		const fresh = markFresh ? finishPlan.fresh : [];
		const last = lastPage;

		writing = true;
		pageError = '';
		try {
			for (const itemId of read) await review(itemId, Grade.Good);
			for (const term of fresh) await markWord(term, true);
			await refresh();
			for (const itemId of read) counted.read.add(itemId);
			for (const itemId of looked) counted.looked.add(itemId);
			for (const term of fresh) counted.fresh.add(term);
			if (last) {
				// The receipt is for the whole read, not the page it happens to sit on.
				const fine = counted.read.size;
				const lost = counted.looked.size;
				const marked = counted.fresh.size;
				const parts =
					fine === 0 && lost === 0
						? ['every garden word here was already reviewed today']
						: [
								`${fine} garden word${fine === 1 ? '' : 's'} read fine`,
								...(lost > 0 ? [`${lost} forgotten`] : [])
							];
				if (marked > 0) parts.push(`${marked} new marked known`);
				summary = parts.join(' · ');
				finished = true;
			} else {
				await turnTo(pageIndex + 2);
			}
		} catch (cause) {
			pageError = cause instanceof Error ? cause.message : 'Could not save this page.';
		} finally {
			writing = false;
		}
	}

	/**
	 * "Look it up": one paid call for a word the glossary missed.
	 *
	 * Fired by the button and by nothing else — a tap is free and has to stay
	 * free, and this is the only thing in the reader that spends. The whole
	 * sentence travels with the word, so a word with several senses comes back in
	 * the one it is being used in; the answer joins `extraGlossary` and the word
	 * turns `new` wherever it appears, which also fills "Add to my words" in with
	 * the meaning, exactly as it is filled for a word the model glossed.
	 */
	async function lookUp() {
		const at = selected;
		const target = card;
		if (!at || !target?.key || !text || !profile || writing || lookingUp) return;

		lookingUp = true;
		cardError = '';
		try {
			const entry = await lookUpWord({
				profile,
				term: target.text,
				sentence: lines[at.line]?.sentence.text ?? target.text,
				title: text.title
			});
			// There is nothing to look up twice — the button is gone the moment the
			// word stops being `plain` — so this only catches an answer that arrives
			// under a spelling something already covers. By `cardKey`, the same rule
			// the text's own glossary dedupes under, so a homograph looked up in two
			// sentences keeps both senses.
			const key = cardKey(entry.term, entry.reading);
			if (!extraGlossary.some((known) => cardKey(known.term, known.reading) === key)) {
				extraGlossary.push(entry);
			}
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not look that word up.';
		} finally {
			lookingUp = false;
		}
	}

	/** `add_words`, verbatim: the one route by which vocabulary enters the garden. */
	async function addWord() {
		const target = card;
		if (!target || writing || draftMeaning === '') return;

		writing = true;
		cardError = '';
		try {
			const reading = cardReading;
			// The outcome is not inspected: `add_words` skips a word already in the
			// list rather than failing, and either way the card re-reads its status
			// from the refreshed garden — which is a better receipt than a sentence.
			await addWordsTool.run(
				{
					words: [
						{
							term: target.text,
							meaning: draftMeaning,
							...(reading ? { romanization: reading } : {})
						}
					]
				},
				defaultToolContext()
			);
			await refresh();
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not add that word.';
		} finally {
			writing = false;
		}
	}

	/** "I know this", and taking it back. A status declaration, never a review. */
	async function mark(known: boolean) {
		const target = card;
		if (!target?.key || writing) return;

		writing = true;
		cardError = '';
		try {
			// `wordMarks` is keyed by the term verbatim while a word's *status* is
			// matched by key, so unmarking has to name the spelling the mark was
			// stored under rather than the one this text happens to use.
			const stored = known
				? target.text
				: (knownTerms.find((term) => wordKey(term) === target.key) ?? target.text);
			await markWord(stored, known);
			await refresh();
		} catch (cause) {
			cardError = cause instanceof Error ? cause.message : 'Could not save that.';
		} finally {
			writing = false;
		}
	}

	/**
	 * Reads the current page aloud, sentence by sentence.
	 *
	 * Sequential on purpose — `speak` resolves when playback finishes, so awaiting
	 * it *is* the pacing. Pressing again cuts the current clip off; the loop then
	 * sees `playing` go false and stops rather than starting the next sentence.
	 *
	 * Synthesis runs *ahead* of playback: a second walk warms every sentence into
	 * the clip cache in order (Kokoro takes a second or two per sentence — as long
	 * as the gap the learner used to hear between them), so by the time the loop
	 * reaches a sentence its clip is local and the only pause left is the one a
	 * full stop deserves. The same trick the session screen plays for its
	 * feedback audio; warming is an optimisation only and every failure inside it
	 * is swallowed. One clip for the whole text was tried and sounded the same,
	 * and a chain starts sooner, stops cleanly and stays under Web Speech's
	 * long-utterance cutoff for the languages Kokoro does not cover.
	 */
	async function listen() {
		if (!text) return;
		if (playing) {
			playing = false;
			stopSpeaking();
			return;
		}

		playing = true;
		const sentences = pageLines.map((line) => line.sentence.text);
		void (async () => {
			for (const sentence of sentences) {
				if (!playing) break;
				await warmSpeech(sentence, lang);
			}
		})();

		try {
			for (const sentence of sentences) {
				if (!playing) break;
				await speak(sentence, lang);
			}
		} finally {
			playing = false;
		}
	}

	/** Forgetting a text. Confirmed inline, because a modal is not a page's voice. */
	async function remove() {
		if (!text || writing) return;
		writing = true;
		pageError = '';
		try {
			stopSpeaking();
			await deleteText(text.id);
			await goto('/read');
		} catch (cause) {
			pageError = cause instanceof Error ? cause.message : 'Could not delete that text.';
			writing = false;
			panel = null;
		}
	}

	/**
	 * The status and maturity classes the colours hang off. `w-new` means two
	 * things — a glossed stranger and a freshly planted word — so the CSS tells
	 * them apart by whether `w-tracked` is there too.
	 */
	function wordClass(word: ReadingWord): string {
		const lapse = isLapsed(word) ? ' w-lapsed' : '';
		return `w w-${word.status}${word.maturity ? ` w-${word.maturity}` : ''}${lapse}`;
	}

	const dates = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});
</script>

<svelte:head>
	<title>{text ? `Sapling · ${text.title}` : 'Sapling · Media'}</title>
</svelte:head>

<!--
  The line-level transport, for a learner whose hands are on the keyboard rather
  than on the video. Only while nothing is focused that wants these keys itself:
  Space is how a button is pressed and an arrow is how a caret moves, and
  stealing either from a text field would be worse than not having the shortcut.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') {
			close();
			return;
		}
		if (!following || event.metaKey || event.ctrlKey || event.altKey) return;

		const focused = document.activeElement;
		const tag = focused instanceof HTMLElement ? focused.tagName : '';
		// `IFRAME` is the YouTube case and is belt and braces: once the player has
		// focus its own document gets the keystrokes and this handler is not called
		// at all. Standing down while it is merely the active element costs nothing
		// and is the honest description of who owns the keyboard.
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'VIDEO') return;
		if (tag === 'IFRAME') return;
		if (focused instanceof HTMLElement && focused.isContentEditable) return;

		if (event.key === ' ') {
			event.preventDefault();
			toggleMedia();
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			replayLine();
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			seekTo(nextIndex);
		}
	}}
/>

<!--
  `.shell-broad` is the reader's cap, and `.shell-follow` lifts it at ≥72rem for
  the follow view only — a new class rather than a scoped `.shell` override,
  which `layout.md` names as the trap: a scoped `max-width` or `padding`
  shorthand opts the route out of the whole system without looking like it.
-->
<main class="shell shell-broad" class:shell-follow={following} class:is-following={following}>
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else if missing || !text}
		<div class="card gone">
			<h1>This text is gone</h1>
			<p class="hint">It was deleted, here or on another device.</p>
			<a class="btn btn-ghost" href="/read">Back to your media</a>
		</div>
	{:else}
		<!--
		  `has-error` exists only so the viewport-fitting grid below can name its
		  rows: the error banner is a `.spread-full` row that comes and goes, and
		  a fixed `auto 1fr` template would put the columns in an implicit third
		  row the moment it appeared.
		-->
		<div
			class="spread reader-spread"
			class:is-following={following}
			class:has-error={pageError !== ''}
		>
			<header class="topbar spread-full ll-rise">
				<a class="back" href="/read" aria-label="Back to your media">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
					</svg>
				</a>
				<div class="identity">
					<p class="eyebrow">
						{text.source === 'generated' ? 'Written for you' : 'You imported this'} · {dates.format(
							text.createdAt
						)}
					</p>
					<h1>{text.title}</h1>
				</div>
				<div class="tools">
					<!-- Not while following: the recording *is* the audio, and offering to
					     synthesise a line that is being spoken on screen is offering the
					     learner a worse version of what they already have. The slot simply
					     goes empty — Delete keeps its place against the right edge and the
					     header keeps its shape. -->
					{#if !following}
						<button
							type="button"
							class="btn btn-ghost tool"
							class:playing
							disabled={!ttsAvailable(lang)}
							title={ttsAvailable(lang) ? 'Read this page aloud' : 'Speech is off — see Settings'}
							onclick={() => void listen()}
						>
							{playing ? 'Stop' : 'Listen'}
						</button>
					{/if}
					<!-- Confirmation lives in the panel, never here: the header's shape
					     stays the same whatever the learner is deciding. -->
					<button
						type="button"
						class="btn btn-ghost tool"
						class:is-active={panel === 'delete'}
						onclick={() => confirm('delete')}
					>
						Delete
					</button>
				</div>
			</header>

			{#if pageError}
				<p class="error spread-full" role="alert">{pageError}</p>
			{/if}

			<!-- The text. Capped at the reading measure whatever the column allows:
			     width buys the word card its own page, never a longer line. -->
			<!-- `--film-width` is the measured width of the picture, handed to the
			     caption rows below so they can match it. Absent until something has
			     been measured, which is what lets the CSS fall back to `--measure`. -->
			<!-- `has-sheet` buys the scroll room the phone's sheet needs, and only
			     while there is a sheet — see `--tail` below. -->
			<div
				class="text-col"
				class:has-sheet={panelOpen}
				style:--film-width={captionWidth > 0 ? `${captionWidth}px` : undefined}
			>
				<!-- The recording, or the ask for it. Sticky, so the line under it stays
				     under it however far the learner scrolls for the word card. -->
				{#if following}
					<div class="stage">
						{#if isYouTube}
							{#if mediaError}
								<!-- The one honest thing to say, and the text underneath is
								     untouched: "Read as text" is two rows down and works. -->
								<p class="stage-fail">{mediaError}</p>
							{:else}
								<!-- Empty on purpose: `$lib/media` puts the iframe in here and
								     owns everything inside it. -->
								<div class="yt-frame" bind:this={frameEl} bind:clientWidth={frameWidth}></div>
							{/if}
						{:else if mediaSrc}
							<!-- svelte-ignore a11y_media_has_caption -->
							<!-- The native controls stay on: scrubbing, volume and fullscreen
							     are free and better than anything written here. Ours are the
							     ones a video does not have — the ones that know where a line
							     begins. The caption track a11y rule is answered by the text
							     beside it, which is the subtitles, annotated. -->
							<video
								bind:this={videoEl}
								bind:clientWidth={filmWidth}
								class="film"
								src={mediaSrc}
								controls
								playsinline
							></video>
						{:else}
							<div class="pick" bind:clientWidth={pickWidth}>
								<p class="pick-copy">
									Choose <strong>{mediaName}</strong> to play it beside the text.
								</p>
								<input
									class="input file-input"
									type="file"
									accept="video/*,audio/*"
									aria-label="Choose the recording"
									onchange={chooseMedia}
								/>
								<p class="hint">
									Only the name was kept — the file itself never left this device, so it is asked
									for once each time you open this.
								</p>
							</div>
						{/if}
					</div>
				{/if}

				<ul class="legend" aria-label="What the underlines mean">
					<li><span class="swatch sw-new" aria-hidden="true"></span>new</li>
					<li><span class="swatch sw-growing" aria-hidden="true"></span>growing</li>
					<li><span class="swatch sw-known" aria-hidden="true"></span>known</li>
				</ul>

				<!-- One continuous body, not a list of sentences: the model returns
				     sentences because the annotation is keyed on them, but the learner
				     reads a text. Written without whitespace between the tokens — they
				     reproduce the sentence character for character, so a newline in the
				     template would land as a rendered space between every pair of them —
				     and the sentences are joined by `gap`, the script's own rule.
				     Only this page's slice is rendered, but the indices stay the whole
				     text's, so `selected` still points into `lines` and a card survives
				     a re-annotation.
				     Following, `pageRange` is the line being spoken — one sentence, or
				     the few that share a cue — and this same loop renders it, which is
				     the whole reason the follow view is a view and not a route. -->
				{#if following && prevIndex >= 0}
					<button type="button" class="neighbour" onclick={() => seekTo(prevIndex)}>
						{sentences[prevIndex]?.text}
					</button>
				{/if}

				<p class="prose">
					{#each pageLines as line, l (pageRange.start + l)}{@const s =
							pageRange.start + l}{#if l > 0}{gap}{/if}<span class="sentence"
							>{#each line.words as word, w (w)}{#if word.key === undefined}{word.text}{:else}<button
										type="button"
										class={wordClass(word)}
										class:is-open={selected?.line === s && selected?.word === w}
										onclick={() => open(s, w)}
										>{#if word.reading}<ruby>{word.text}<rt>{word.reading}</rt></ruby
											>{:else}{word.text}{/if}</button
									>{/if}{/each}</span
						>{/each}
				</p>

				<!-- The neighbours are plain text, not annotated: they are context, and a
				     tappable word in a line nobody is reading is a word tapped by
				     accident. Each is a seek, which is what "I want to hear that again"
				     and "get on with it" both mean here. -->
				{#if following && currentIndex < 0}
					<p class="hint waiting">
						Nothing is being spoken yet — press play, or tap the line below.
					</p>
				{/if}

				{#if following && nextIndex >= 0}
					<button type="button" class="neighbour" onclick={() => seekTo(nextIndex)}>
						{sentences[nextIndex]?.text}
					</button>
				{/if}

				<!-- Reading the translation stays a decision, as in conversation mode;
				     so does the stored reading, which only exists here when there is no
				     ruby to carry it. -->
				{#if translation || storedReading}
					<div class="text-tools">
						{#if storedReading}
							<button type="button" class="reveal" onclick={() => (showReading = !showReading)}>
								{showReading ? 'Hide reading' : 'Reading'}
							</button>
						{/if}
						{#if translation}
							<button
								type="button"
								class="reveal"
								onclick={() => (showTranslation = !showTranslation)}
							>
								{showTranslation ? 'Hide translation' : 'Translation'}
							</button>
						{/if}
					</div>
				{/if}

				{#if showReading && storedReading}
					<p class="rom reading-block">{storedReading}</p>
				{/if}

				{#if showTranslation && translation}
					<p class="translation">{translation}</p>
				{/if}

				<!--
				  The line controls, and with them the way out of this view. They live
				  here rather than in the header because the header keeps one shape and
				  because they belong to the video, which is the thing directly above
				  them. Everything is a *line* operation: scrubbing, volume and
				  fullscreen are the native bar's, and better there.
				-->
				{#if following}
					<div class="transport">
						<div class="transport-keys">
							<button
								type="button"
								class="btn btn-ghost tool"
								disabled={!playable}
								onclick={replayLine}
							>
								Replay line
							</button>
							<button
								type="button"
								class="btn btn-primary tool"
								disabled={!playable}
								onclick={toggleMedia}
							>
								{mediaPaused ? 'Play' : 'Pause'}
							</button>
							<button
								type="button"
								class="btn btn-ghost tool"
								disabled={!playable || nextIndex < 0}
								onclick={() => seekTo(nextIndex)}
							>
								Next line
							</button>
						</div>
						<label class="transport-opt">
							<input type="checkbox" bind:checked={autoPause} disabled={!playable} />
							Stop at the end of each line
						</label>
						<!-- Said rather than fought: once the learner clicks inside YouTube's
						     iframe it owns the keyboard, and Space and the arrows go to its
						     shortcuts instead of ours. Stealing focus back from a player
						     somebody just clicked on would be worse than the buttons above,
						     which always work. -->
						{#if isYouTube}
							<p class="hint transport-hint">
								Space and ← → work these — until you click inside the video, after which the
								keyboard is YouTube's. Click the text to take it back.
							</p>
						{/if}
						<!-- The paged reader is where a text is *finished* — the receipt and
						     the page grading live there, and nothing here writes a grade. -->
						<button type="button" class="reveal" onclick={() => void setView('text')}>
							Read as text
						</button>
					</div>
				{:else if followable}
					<div class="transport">
						<button type="button" class="reveal" onclick={() => void setView('follow')}>
							Follow the video
						</button>
					</div>
				{/if}

				<!-- At the end of the page, because that is where the learner is when
				     they have read it. The primary action carries the page forward and
				     confirms in the panel first, because it writes; going *back* writes
				     nothing, so it is a quiet link beside it. The receipt takes the
				     button's place on the last page.
				     Paged view only: a video that keeps playing while the learner looks
				     out of the window has said nothing about what they remember, so the
				     clock turns no grades and there is nothing here to confirm. -->
				{#if !following}
					<div class="finish-row">
						<p class="page-count">Page {pageIndex + 1} of {pageCount}</p>
						<div class="finish-actions">
							{#if finished}
								<p class="summary" aria-live="polite">Finished · {summary}</p>
							{:else}
								<button
									type="button"
									class="btn btn-primary finish-btn"
									class:is-active={panel === 'finish'}
									onclick={() => confirm('finish')}
								>
									{lastPage ? 'Finished reading' : 'Next page'}
								</button>
							{/if}
							{#if pageIndex > 0}
								<button type="button" class="reveal" onclick={() => void turnTo(pageIndex)}>
									Previous page
								</button>
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<!-- The panel: the word card, or a confirmation in its place. A facing
			     page at 48rem, a sheet at the foot of the phone below it — and, in the
			     follow view with nothing open, the transcript, which the card
			     *replaces* rather than sits beside: one slot, whatever it holds. -->
			<aside class="card-col" class:is-open={panelOpen}>
				{#if panel === 'finish'}
					<div class="word-card">
						<div class="word-head">
							<div class="word-id">
								<p class="panel-title">
									{finished ? 'Counted' : lastPage ? 'Finished reading?' : 'Done with this page?'}
								</p>
							</div>
							<button type="button" class="close" aria-label="Close" onclick={close}>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						</div>

						{#if finished}
							<p class="panel-copy">{summary}</p>
							<hr class="stitch" />
							<button type="button" class="btn btn-ghost btn-block" onclick={close}>Close</button>
						{:else}
							<p class="panel-copy">
								{#if finishPlan.read.length === 0 && finishPlan.looked.length === 0}
									Every garden word on this page was already reviewed today, so there is nothing new
									to count.
								{:else}
									{finishPlan.read.length} garden word{finishPlan.read.length === 1 ? '' : 's'} on this
									page that you read without looking up will be reviewed as remembered{finishPlan
										.looked.length > 0
										? `; ${finishPlan.looked.length} you looked up ${finishPlan.looked.length === 1 ? 'is' : 'are'} already counted as forgotten`
										: ''}.
								{/if}
							</p>
							{#if finishPlan.fresh.length > 0}
								<label class="finish-opt">
									<input type="checkbox" bind:checked={markFresh} />
									Also mark the {finishPlan.fresh.length} new word{finishPlan.fresh.length === 1
										? ''
										: 's'} I didn't tap as known
								</label>
							{/if}
							<hr class="stitch" />
							<div class="word-actions">
								<button
									type="button"
									class="btn btn-primary"
									disabled={writing}
									onclick={() => void finishPage()}
								>
									{writing ? 'Saving…' : lastPage ? 'Yes, done' : 'Yes, next page'}
								</button>
								<button type="button" class="btn btn-ghost" disabled={writing} onclick={close}>
									Not yet
								</button>
							</div>
						{/if}
					</div>
				{:else if panel === 'delete'}
					<div class="word-card">
						<div class="word-head">
							<div class="word-id">
								<p class="panel-title">Delete this text?</p>
							</div>
							<button type="button" class="close" aria-label="Close" onclick={close}>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						</div>
						<p class="panel-copy">
							It goes for good, here and on every paired device. Words you added or marked from it
							stay.
						</p>
						<hr class="stitch" />
						<div class="word-actions">
							<button
								type="button"
								class="btn btn-ghost danger"
								disabled={writing}
								onclick={() => void remove()}
							>
								Delete for good
							</button>
							<button type="button" class="btn btn-ghost" disabled={writing} onclick={close}>
								Keep
							</button>
						</div>
					</div>
				{:else if card}
					<div class="word-card">
						<div class="word-head">
							<div class="word-id">
								<p class="word-term">{card.text}</p>
								{#if cardReading}<span class="rom">{cardReading}</span>{/if}
							</div>
							<SpeakButton text={card.text} {lang} />
							<button type="button" class="close" aria-label="Close" onclick={close}>
								<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="m7 7 10 10M17 7 7 17" />
								</svg>
							</button>
						</div>

						<p class="word-status">{statusLine(card)}</p>

						{#if card.gloss}
							<p class="word-meaning">{card.gloss.meaning}</p>
						{/if}

						<!-- A tracked word has no actions here: the garden is where it is
						     managed, and a reading session is not the place to leave for it. -->
						{#if card.status !== 'tracked'}
							<hr class="stitch" />
						{/if}

						{#if card.status === 'tracked'}{:else if card.status === 'known'}
							<button
								type="button"
								class="btn btn-ghost btn-block"
								disabled={writing}
								onclick={() => void mark(false)}
							>
								Unmark
							</button>
						{:else}
							{#if !card.gloss}
								<label class="field">
									<span class="label">What does it mean?</span>
									<input
										class="input"
										type="text"
										placeholder="In {profile?.nativeLanguage ?? 'your language'}"
										disabled={writing || lookingUp}
										bind:value={meaningDraft}
										onkeydown={(event) => {
											if (event.key === 'Enter') void addWord();
										}}
									/>
								</label>
							{/if}
							<div class="word-actions">
								<button
									type="button"
									class="btn btn-primary"
									disabled={writing || lookingUp || draftMeaning === ''}
									onclick={() => void addWord()}
								>
									Add to my words
								</button>
								<!-- Only where nobody has said anything about the word — and only
								     on a press, because it is the one thing in the reader that
								     costs. A word with a gloss already has its answer. -->
								{#if !card.gloss}
									<button
										type="button"
										class="btn btn-ghost"
										disabled={writing || lookingUp}
										onclick={() => void lookUp()}
									>
										{lookingUp ? 'Looking up…' : 'Look it up'}
									</button>
								{/if}
								<button
									type="button"
									class="btn btn-ghost"
									disabled={writing || lookingUp}
									onclick={() => void mark(true)}
								>
									I know this
								</button>
							</div>
						{/if}

						{#if cardError}
							<p class="error card-error" role="alert">{cardError}</p>
						{/if}
					</div>
				{:else if showTranscript}
					<!-- The whole text as a list, opposite the line being spoken: the
					     spread's usual pairing, one thing on each page. Rendered only
					     where there *is* a facing page — a phone would be building a
					     button per sentence to hide every one of them. -->
					<div class="transcript">
						<p class="panel-title">Transcript</p>
						<ol class="transcript-list">
							{#each sentences as sentence, i (i)}
								<li>
									<button
										type="button"
										class="t-line"
										class:is-now={i >= currentRange.start && i < currentRange.end}
										bind:this={transcriptRows[i]}
										disabled={sentence.start === undefined}
										onclick={() => seekTo(i, true)}
									>
										{sentence.text}
									</button>
								</li>
							{/each}
						</ol>
					</div>
				{/if}
			</aside>
		</div>
	{/if}
</main>

<style>
	/* Width and the side gutter are the global `.shell`/`.shell-broad` pair's
	   job; only the vertical rhythm is this route's own. */
	.shell {
		padding-block: 1.5rem 4rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	.gone h1 {
		font-size: 1.35rem;
	}

	.gone .btn {
		margin-top: 0.75rem;
		text-decoration: none;
	}

	/* One hand for every icon here: 24-unit box, hairline stroke, round joins. */
	.ico {
		width: 1.2rem;
		height: 1.2rem;
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.topbar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem;
	}

	.back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.back:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.back:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.identity {
		flex: 1 1 12rem;
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.1rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.45rem;
		line-height: 1.15;
		overflow-wrap: anywhere;
	}

	.tools {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.tool {
		padding: 0.4rem 0.85rem;
		border-color: var(--border);
		font-size: 0.82rem;
	}

	.tool.playing {
		border-color: var(--primary);
		color: var(--primary-strong);
	}

	.tool.is-active {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.btn.danger {
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
		color: var(--danger);
	}

	.btn.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	/* The text ------------------------------------------------------------ */

	.text-col {
		max-width: var(--measure);
	}

	/*
	  Room under the last line for the sheet that covers the foot of the phone —
	  the sheet is pinned to the viewport and this is what keeps the lines under
	  it reachable.

	  **Paged, it is always there.** Adding padding on tap would make the page
	  scrollable in the same instant, and the scrollbar popping in reads as the
	  layout jumping; a page of prose is taller than the viewport anyway, so a
	  tail at the end of it costs nothing that can be seen.

	  **Following, it is there only while a sheet is.** That column is a picture
	  and a handful of rows — shorter than the phone it is on — so a permanent
	  tail is the *only* thing making the page scroll, and what it scrolls into is
	  half a screen of nothing under the controls. Reserving it when the panel
	  opens moves nothing above it (padding grows downwards, and the sheet is
	  what the eye is on), and it is the one moment anything needs to be scrolled
	  clear: the stage is sticky, so the learner can push the spoken line up under
	  the video and out from under the card. The alternative — no tail ever, and
	  the sheet simply covering the transport — loses the *line* as well on a
	  short viewport, which is the one thing the card is about.

	  Carried as a custom property rather than a `padding-bottom` of its own so
	  that the ≥48rem frame can go on setting the padding to zero: a rule naming
	  the open-sheet class would otherwise outrank it and put half a screen of air
	  back inside the frame.
	*/
	.text-col {
		--tail: 45dvh;
		padding-bottom: var(--tail);
	}

	.is-following .text-col {
		--tail: 0;
	}

	.is-following .text-col.has-sheet {
		--tail: 45dvh;
	}

	/* The recording --------------------------------------------------------- */

	/*
	  Sticky at the top of the column, which on a phone is the top of the screen:
	  the line being spoken sits directly under the picture, and it has to stay
	  under it while the learner scrolls down for the word card. `--surface` behind
	  it because a sticky element with a transparent ground shows the prose sliding
	  through it.
	*/
	.stage {
		position: sticky;
		top: 0;
		z-index: 5;
		margin-bottom: 1rem;
		padding-block: 0.5rem;
		background: var(--surface);
	}

	/* 16:9 by declaration rather than by the file's own dimensions, so the layout
	   does not jump when the metadata lands. An audio file gets the same box; the
	   native bar sits in the middle of it. */
	.film {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		border-radius: var(--radius);
		background: #000;
	}

	/*
	  YouTube's box. A `<div>` has no intrinsic aspect ratio the way a `<video>`
	  does, so 16:9 is declared here and the iframe fills it — and `overflow`
	  clips the player's own square corners into the app's radius.

	  `:global(iframe)`, because the iframe is not in this template: the API
	  creates it, so Svelte's scoping class is never on it and a plain descendant
	  selector would match nothing.
	*/
	.yt-frame {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: var(--radius);
		background: #000;
	}

	.yt-frame :global(iframe) {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}

	/* The API never turned up. One line, in the picture's place, in the picture's
	   box — the text below it is untouched and "Read as text" is two rows down. */
	.stage-fail {
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0;
		aspect-ratio: 16 / 9;
		padding: 1rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-alt);
		color: var(--text-muted);
		font-size: 0.95rem;
		text-align: center;
	}

	/* The file is not in hand: what to look for, and the picker. Same box as the
	   video it stands in for, so nothing moves when it is chosen. */
	.pick {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 0.6rem;
		aspect-ratio: 16 / 9;
		padding: 1rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.pick-copy {
		margin: 0;
		font-size: 0.95rem;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.pick .file-input {
		padding: 0.4rem 0.5rem;
		font-size: 0.82rem;
	}

	.pick .hint {
		margin: 0;
		font-size: 0.78rem;
	}

	/*
	  The lines either side of the one being spoken. Faint and plain — they are
	  context and a seek, not reading, and their words are deliberately not
	  tappable: a word tapped in a line nobody is on is a word tapped by accident.
	*/
	.neighbour {
		display: block;
		width: 100%;
		margin: 0;
		padding: 0.35rem 0;
		border: 0;
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 1rem;
		line-height: 1.5;
		text-align: left;
		opacity: 0.55;
		cursor: pointer;
		transition: opacity 0.15s ease;
	}

	.neighbour:hover {
		opacity: 0.9;
	}

	.neighbour:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.waiting {
		margin: 0.5rem 0;
	}

	/* The line controls. One row that wraps, like every other control row here —
	   no breakpoint, because the three buttons and the checkbox stack in source
	   order on a narrow phone and that is the right order. */
	.transport {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.6rem 1rem;
		margin-top: 1.25rem;
		padding-top: 1rem;
		border-top: 1px dashed var(--border);
	}

	.transport-keys {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}

	.transport-opt {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text-muted);
		cursor: pointer;
	}

	.transport-opt input {
		accent-color: var(--primary);
	}

	/* A whole row of its own inside the wrapping transport: it is a caveat about
	   the keyboard, not a control, and a sentence squeezed between two buttons
	   reads as one. */
	.transport-hint {
		flex: 1 0 100%;
		margin: 0;
		font-size: 0.78rem;
	}

	.legend {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem 1rem;
		margin: 0 0 1.25rem;
		padding: 0 0 0.85rem;
		border-bottom: 1px dashed var(--border-strong);
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.swatch {
		display: inline-block;
		width: 1.1rem;
		height: 0;
		border-bottom: 2px solid currentColor;
	}

	.sw-new {
		color: var(--accent);
	}

	.sw-growing {
		color: color-mix(in srgb, var(--primary) 55%, var(--amber));
	}

	/* Known words carry no mark at all, so the swatch says "nothing here". */
	.sw-known {
		color: var(--border-strong);
		border-bottom-style: dotted;
	}

	/*
	  Target-script prose: a touch larger than body text because it is the
	  specimen, and set at 1.9 so ruby has somewhere to sit without the lines
	  colliding — the same figure `RubyText` uses for the same reason.
	*/
	.prose {
		margin: 0;
		font-size: 1.15rem;
		line-height: 1.9;
		overflow-wrap: anywhere;
	}

	/*
	  Following, the prose is one caption that changes with every cue, and a line
	  that wraps to two is the common case rather than the rare one. Left in flow
	  it takes a line's height away from whatever is under it on the phone — the
	  neighbour, the controls — and from the picture itself inside the ≥48rem
	  frame, where the stage is what gives. Either way the whole view twitches on
	  a cue change.

	  So two lines of room are always there. Two rather than three because three
	  is rare and a caption that occasionally grows is much cheaper than a
	  permanent band of air under every short line. In `lh`, so the ≥72rem font
	  bump carries it up with the text; `em` first for anything that has not
	  learned the unit, at this element's own 1.9 line-height.

	  It also steadies the frame's feedback loop rather than feeding it: with the
	  height of a one- or two-line caption fixed, the room left for the video no
	  longer changes on those cues, so `--film-width` stops moving and the caption
	  stops being re-wrapped by its own height.
	*/
	.is-following .prose {
		min-height: 3.8em;
		min-height: 2lh;
	}

	/* A sentence is a run inside the paragraph, not a block of its own — the
	   span exists so a later slice can mark or play one, not to break the text. */
	.sentence {
		display: inline;
	}

	/*
	  A word is a real button — Tab reaches it, Enter opens it — wearing none of a
	  button's clothes. `display: inline` is what lets a long word wrap inside the
	  paragraph instead of being an unbreakable block in the middle of it.
	*/
	.w {
		display: inline;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: 3px;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.w:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.w ruby {
		ruby-position: over;
		ruby-align: center;
	}

	/*
	  The annotation wears `.rom`'s clothes: body face, muted ink, a touch of
	  tracking. Clamped at 0.72rem because pinyin legibility lives in the tone
	  marks, and below that ā/á/ǎ/à stop being distinguishable.
	*/
	.w rt {
		font-family: var(--font);
		font-size: max(0.5em, 0.72rem);
		font-weight: 500;
		font-variation-settings: normal;
		letter-spacing: 0.02em;
		line-height: 1.2;
		color: var(--text-muted);
		user-select: none;
	}

	/*
	  A word the text glosses: an accent underline, the loudest mark on the page,
	  because it is the one the reader most likely needs. `:not(.w-tracked)`
	  because a freshly planted word is `w-tracked w-new` and belongs to the beds
	  below, not here.
	*/
	.w-new:not(.w-tracked) {
		text-decoration: underline;
		text-decoration-color: var(--accent);
		text-decoration-thickness: 2px;
		text-underline-offset: 0.22em;
	}

	/* Tracked words wear the garden's own bed colours, softened: this is a text,
	   not a progress bar, and three saturated underlines would read as errors. */
	.w-tracked {
		text-decoration: underline;
		text-decoration-thickness: 1.5px;
		text-underline-offset: 0.22em;
	}

	/* A garden word looked up in this text: the underline keeps its bed colour
	   and loses its solidity. A change of texture, not of hue — one more colour
	   on a page that already carries three would read as an alarm. */
	.w-tracked.w-lapsed {
		text-decoration-style: dotted;
		text-decoration-thickness: 2px;
	}

	.w-tracked.w-new {
		text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
	}

	.w-tracked.w-young {
		text-decoration-color: color-mix(
			in srgb,
			color-mix(in srgb, var(--primary) 55%, var(--amber)) 55%,
			transparent
		);
	}

	.w-tracked.w-solid {
		text-decoration-color: color-mix(in srgb, var(--primary) 55%, transparent);
	}

	/* `known` and `plain` are deliberately bare — nothing to say about a word the
	   learner reads straight through. */

	.w.is-open {
		background: var(--primary-soft);
	}

	.text-tools {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-top: 0.9rem;
	}

	.reading-block {
		margin: 0.6rem 0 0;
		line-height: 1.6;
	}

	/* Reading the translation stays a decision, as it is in conversation mode. */
	.reveal {
		padding: 0;
		border: 0;
		background: none;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.8rem;
		text-decoration: underline dotted;
		text-underline-offset: 3px;
		cursor: pointer;
	}

	.reveal:hover {
		color: var(--text);
	}

	.reveal:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.translation {
		margin: 0.6rem 0 0;
		color: var(--text-muted);
		font-size: 0.95rem;
		line-height: 1.6;
	}

	/* The word card ------------------------------------------------------- */

	/*
	  The base case is a phone, so the card is a sheet pinned to the foot of the
	  viewport — the text stays where it was and the answer comes to the thumb.
	  The wide layout below turns it back into a facing page.
	*/
	.card-col.is-open {
		position: fixed;
		z-index: 20;
		left: 0;
		right: 0;
		bottom: 0;
		/* Within the tail `.text-col` reserves, so the sheet never covers a
		   line the page cannot scroll clear of. */
		max-height: 45dvh;
		overflow-y: auto;
		padding-inline: var(--gutter);
		padding-bottom: env(safe-area-inset-bottom);
	}

	.word-card {
		padding: 1rem 1.1rem 1.2rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		background: var(--surface);
		box-shadow: var(--shadow);
	}

	.word-head {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}

	.word-id {
		flex: 1 1 auto;
		min-width: 0;
	}

	.word-term {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.4rem;
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1.9rem;
		height: 1.9rem;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text-muted);
		cursor: pointer;
	}

	.close:hover {
		border-color: var(--border);
		background: var(--surface-alt);
		color: var(--text);
	}

	.close:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.word-status {
		margin: 0.5rem 0 0;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.word-meaning {
		margin: 0.3rem 0 0;
		font-size: 1.02rem;
		line-height: 1.45;
	}

	.word-card .stitch {
		margin: 0.9rem 0;
	}

	.word-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.word-actions .btn {
		flex: 1 1 9rem;
		padding: 0.65rem 1rem;
		font-size: 0.88rem;
	}

	/* The end of the page: where it sits in the text, one primary action, then
	   its receipt in its place. Separated from the prose by the same stitch the
	   cards use. */
	.finish-row {
		margin-top: 2rem;
		padding-top: 1.25rem;
		border-top: 1px dashed var(--border);
	}

	/* Wears the word card's status voice, because it says the same kind of thing:
	   where you are, not what to do. */
	.page-count {
		margin: 0 0 0.75rem;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	/* Forward and back on one line, wrapping on a narrow phone. No breakpoint:
	   the row holds one button and a link at every width. */
	.finish-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem 1.1rem;
	}

	.finish-btn.is-active {
		box-shadow: var(--ring);
	}

	.summary {
		margin: 0;
		color: var(--primary-strong);
		font-weight: 700;
	}

	.panel-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
		font-weight: 700;
		line-height: 1.25;
		letter-spacing: -0.01em;
	}

	.panel-copy {
		margin: 0.6rem 0 0;
		font-size: 0.95rem;
		line-height: 1.5;
		color: var(--text-muted);
	}

	.finish-opt {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin-top: 0.75rem;
		font-size: 0.92rem;
		line-height: 1.4;
		cursor: pointer;
	}

	.finish-opt input {
		accent-color: var(--primary);
	}

	.error {
		margin: 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	.card-error {
		margin-top: 0.75rem;
	}

	@media (min-width: 48rem) {
		/*
		  The spread opens: the text on one page, the word card on the other, and
		  the card follows the reader down instead of being scrolled past. Every
		  line here undoes one of the sheet's, which is the price of writing the
		  phone as the base case rather than as the exception.
		*/
		.card-col.is-open {
			position: sticky;
			z-index: auto;
			top: 1rem;
			left: auto;
			right: auto;
			bottom: auto;
			max-height: none;
			overflow: visible;
			padding-inline: 0;
			padding-bottom: 0;
		}

		.word-card {
			border-radius: var(--radius-lg);
		}

		.text-col {
			padding-bottom: 0;
		}

		/* The follow view fits the viewport --------------------------------- */

		/*
		  Following, the page does not scroll: the frame is the viewport and the
		  transcript scrolls inside itself. The alternative — what this replaces —
		  was a sticky panel under a header, which means the window scrolls first
		  and the sticky only takes over once the header is gone. That reads as
		  the page lurching before it settles.

		  Only `padding-block` is touched, which is the route's to own; the sides
		  stay the global rule's (`layout.md` names a scoped `padding` shorthand
		  as the trap). The 4rem tail is scroll room, and a page that does not
		  scroll has no use for it.
		*/
		.shell.is-following {
			padding-block: 1.5rem;
		}

		/*
		  Header row auto, content row whatever is left. `minmax(0, 1fr)` rather
		  than `1fr`, because a grid track's default minimum is its content and a
		  transcript of two hundred lines would push the row straight past the
		  frame it is supposed to fit inside.
		*/
		.reader-spread.is-following {
			height: calc(100dvh - 3rem);
			grid-template-rows: auto minmax(0, 1fr);
			/* `.spread` sets `align-items: start`, which is what makes two cards
			   read as facing pages — and exactly wrong for two columns that have to
			   fill a frame. */
			align-items: stretch;
		}

		/* The error banner is a `.spread-full` row that comes and goes; naming it
		   here is what stops the columns landing in an implicit third row. */
		.reader-spread.is-following.has-error {
			grid-template-rows: auto auto minmax(0, 1fr);
		}

		/* A grid item's `min-height: auto` refuses to shrink below its content,
		   which would defeat the whole frame. Both columns opt out. */
		.is-following .text-col,
		.is-following .card-col {
			min-height: 0;
		}

		/*
		  The left page as a column: the picture takes whatever is left once the
		  line and the controls have had theirs, and never more. `overflow-y` is
		  the guard for a window too short to hold even that — the column scrolls
		  itself rather than the window.
		*/
		.is-following .text-col {
			display: flex;
			flex-direction: column;
			max-width: none;
			padding-bottom: 0;
			overflow-y: auto;
		}

		/* Nothing to stick to any more — the column is the frame. */
		.is-following .stage {
			position: static;
			display: flex;
			justify-content: center;
			flex: 1 1 auto;
			min-height: 8rem;
			padding-block: 0;
		}

		/*
		  Height first, width derived from it: the stage is a flex item with a
		  definite height, so `height: 100%` resolves against it and the aspect
		  ratio decides the rest. That is what keeps the picture as big as the room
		  allows without the column ever growing past the frame.
		*/
		.is-following .film {
			height: 100%;
			width: auto;
			max-width: 100%;
			object-fit: contain;
		}

		/*
		  The same trade for YouTube, with the ratio doing the work the video's own
		  dimensions do above: a definite height from the stage, `width: auto`, and
		  `aspect-ratio` derives the width — which is what `bind:clientWidth` then
		  measures for the caption. `max-width` is what keeps a short, wide window
		  from pushing the picture out of the column; the ratio holds and the height
		  gives instead.
		*/
		.is-following .yt-frame {
			height: 100%;
			width: auto;
			max-width: 100%;
			aspect-ratio: 16 / 9;
		}

		.is-following .pick,
		.is-following .stage-fail {
			aspect-ratio: auto;
			width: 100%;
			height: 100%;
		}

		/*
		  The caption block matches the picture it sits under, because that is what
		  a caption does — it belongs to the video, not to the column.
		  `--film-width` is measured (no stylesheet can derive it: the video is
		  sized from its height), and the `max` keeps `--measure` as a floor so a
		  portrait or a small video does not squeeze the line into a ribbon; the
		  `min` keeps it inside the column whatever happens. With nothing measured
		  yet the fallback collapses the whole expression to `--measure`, which is
		  where this started.

		  This is not a hole in the measure rule: a caption is one sentence at a
		  time, not a paragraph, and `--measure` still governs every run of prose.

		  `flex: 0 0 auto` so the stage stays the only thing that gives.
		*/
		.is-following .legend,
		.is-following .neighbour,
		.is-following .prose,
		.is-following .waiting,
		.is-following .text-tools,
		.is-following .reading-block,
		.is-following .translation,
		.is-following .transport {
			flex: 0 0 auto;
			width: min(100%, max(var(--film-width, var(--measure)), var(--measure)));
			max-width: none;
			margin-inline: auto;
		}

		/*
		  The panel column holds one thing at a time and that thing fills it. The
		  word card scrolls itself instead of sticking, because there is no longer
		  a scrolling window for it to stick within.
		*/
		.is-following .card-col {
			display: flex;
			flex-direction: column;
		}

		.is-following .card-col.is-open {
			position: static;
			top: auto;
			overflow-y: auto;
		}

		/*
		  The transcript is the one thing here that is taller than the frame on
		  purpose, so it is the scroller — and it wears the word card's own skin,
		  because it takes the word card's slot. Its heading is sticky against
		  that surface, not against the page: `--surface` is what `.word-card`
		  paints, and a heading in `--bg` reads as a bar laid over the panel
		  rather than as the panel's own top edge. The negative margins let it
		  cover the card's padding, so nothing scrolls through the gap beside it.
		*/
		/*
		  **No top padding, and no side padding.** The scroller's own padding is
		  what a sticky heading at `top: 0` sticks *below* — lines then scroll
		  through the strip above it and the title sits visibly too low. So the
		  padding moves inward: the title is the first child, flush at the top edge
		  and full width of the scroller, carrying the card's top and side padding
		  itself; the list carries the sides. Nothing can be seen above the title
		  because there is nothing above it.
		*/
		.transcript {
			flex: 1 1 auto;
			min-height: 0;
			overflow-y: auto;
			padding: 0 0 1.2rem;
			border: 1px solid var(--border);
			border-radius: var(--radius-lg);
			background: var(--surface);
			box-shadow: var(--shadow);
		}

		.transcript .panel-title {
			position: sticky;
			top: 0;
			z-index: 1;
			margin: 0;
			padding: 1rem 1.1rem 0.5rem;
			border-bottom: 1px dashed var(--border);
			background: var(--surface);
		}

		/* 0.6rem here plus `.t-line`'s own 0.5rem puts the transcript's text on the
		   same 1.1rem line as the title above it. */
		.transcript-list {
			list-style: none;
			margin: 0.5rem 0 0;
			padding: 0 0.6rem;
		}

		/* A line of the transcript is a seek, so it is a button — but a transcript
		   of buttons wearing button clothes is a wall of boxes. It reads as text
		   and only the current line is marked. */
		.t-line {
			display: block;
			width: 100%;
			margin: 0;
			padding: 0.3rem 0.5rem;
			border: 0;
			border-left: 2px solid transparent;
			border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
			background: none;
			color: var(--text-muted);
			font: inherit;
			font-size: 0.92rem;
			line-height: 1.5;
			text-align: left;
			cursor: pointer;
			overflow-wrap: anywhere;
		}

		.t-line:hover:not(:disabled) {
			background: var(--surface-alt);
			color: var(--text);
		}

		.t-line:focus-visible {
			outline: none;
			box-shadow: var(--ring);
		}

		/* An untimed sentence — prose spliced into a transcript — is still shown,
		   because it is part of the text; it just has nowhere to seek to. */
		.t-line:disabled {
			cursor: default;
			opacity: 0.6;
		}

		.t-line.is-now {
			border-left-color: var(--primary);
			background: var(--primary-soft);
			color: var(--text);
			font-weight: 500;
		}
	}

	@media (min-width: 72rem) {
		/* Full desktop: the text is what the page is for, so it takes more of the
		   extra width than the card opposite it. */
		.reader-spread {
			grid-template-columns: 3fr 2fr;
		}

		/*
		  The documented exception to "width never makes content bigger" — see
		  `layout.md`. A recording is the one thing in the app that is genuinely
		  better large, so the follow view drops the 64rem cap and spends the whole
		  viewport on it, gutters aside. This is a *new* class on `<main>` rather
		  than a scoped `.shell` override, which would opt the route out of the
		  global system without looking like it. The paged view (`?view=text`)
		  never wears it and keeps `.shell-broad` exactly as it was.
		*/
		.shell-follow {
			max-width: none;
		}

		/* The video column takes the room; the transcript stays a bounded facing
		   column, because a transcript stretched across a desk is the
		   over-widening `layout.md` warns about. The caption under the video
		   matches the video, per the block above. */
		.reader-spread.is-following {
			grid-template-columns: minmax(0, 1fr) minmax(20rem, 28rem);
		}

		/* A notch up, because at this size the line is a caption under a large
		   picture rather than a paragraph on a page, and at 1.15rem it reads as an
		   afterthought under it. */
		.is-following .prose {
			font-size: 1.3rem;
		}
	}
</style>
