<!--
  The reading library: every text the learner has kept, and the two doors to one
  more.

  A spread, and the pairing is the usual one — the *doing* (write me one, or
  paste one in) opposite the *state* (what is already on the shelf). On a phone
  the composer comes first, because an empty shelf is the common case on the day
  someone finds this page.

  The two doors cost the same round trip and differ only in what the model is
  asked for: `generateReadingText` writes a text out of the garden, while
  `annotateReadingText` takes a text the learner imported and only annotates it —
  the sentences are cut here, locally, so what lands on the reader is exactly
  what was pasted. Both come back as a draft; this page mints the id and the
  timestamp and stores it, which is the whole reason `$lib/reading` can stay
  stateless.

  **The import door has three parts, in the order the questions arise**: what the
  text is, what it will cost, and what it should play alongside.

  *What it is* has two shapes and shows one of them. A paste stays in the box —
  prose, a copied transcript panel, anything typed. An **uploaded file is an
  object, not a paste**: a subtitle file is a thousand lines of cue soup, and
  pouring it into the textarea buried the only thing worth seeing, which is what
  the app made of it. So it becomes a card stating its own facts (what format,
  how many cues, how many sentences, how long, how many calls) with a × that
  gives the box back. The file's *content* decides which shape it takes, not its
  extension: anything the detector recognises becomes the card, anything else is
  a paste and lands in the box, where it can still be read and edited.

  *What it costs* is a row that never moves: the sentence and call count for
  what is in the box, and the character counter, both before the button and
  whichever source they describe.

  *What it plays alongside* is a group that is **always there**, disabled rather
  than absent while the text has no timings — a control that materialises only
  when a paste happens to parse is a feature nobody knows exists. One recording,
  chosen two ways — a file on this device, or a YouTube link — and the fields
  clear each other, because "which of these two is it" is not a question the
  reader should have to answer later. Attached now or never: a text is
  immutable. What is *stored* is a reference either way: a video id, or a file's
  name and nothing else. The file handle itself goes into `$lib/media`'s session
  cache, so the reader opening a second later already has it and every later
  open asks for it again.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';

	import { getAllItems, getKnownTerms, getProfile, getTexts } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import { videoIdFrom } from '$lib/media';
	import {
		MAX_FOCUS_WORDS,
		MAX_IMPORT_TOTAL_CHARS,
		MAX_TOPIC_CHARS,
		cuesToSentences,
		detectSubtitleFormat,
		importCallCount,
		parseSubtitles,
		splitSentences
	} from '$lib/reading';
	import type { SubtitleFormat } from '$lib/reading';
	import { selectSessionItems } from '$lib/srs';
	import { startTask } from '$lib/tasks';
	import type { TaskOutcome } from '$lib/tasks';
	import { taskStore } from '$lib/tasks/store.svelte';
	import type { KnowledgeItem, Profile, ReadingMedia, ReadingText } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	/** Nudges, not choices — the same shape `/converse` offers over its topic box. */
	const EXAMPLE_TOPICS = ['A morning at the market', 'A letter from home', 'Something spooky'];

	/** Which composer is open. Not a mode: the two write the same kind of text. */
	type Door = 'write' | 'paste';

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let items = $state<KnowledgeItem[]>([]);
	let texts = $state<ReadingText[]>([]);
	let mockMode = $state(false);

	/** What a recognised file is called on screen, in the learner's terms. */
	const FORMAT_NAMES: Record<SubtitleFormat, string> = {
		srt: 'SRT subtitles',
		vtt: 'WebVTT subtitles',
		'youtube-transcript': 'YouTube transcript'
	};

	let door = $state<Door>('write');
	let topic = $state('');
	let title = $state('');
	let pasted = $state('');
	/**
	 * A subtitle file the learner uploaded, held as an *object* rather than poured
	 * into the box.
	 *
	 * A subtitle file is not a paste. It is a thousand lines of cue soup nobody
	 * wants to read, let alone edit, and dropping it into the textarea buried the
	 * one thing the learner does want to see — what the app made of it. So the
	 * file becomes a card that states its own facts, and the box stays what it is
	 * for: text somebody typed or copied. The two are alternatives, and the card
	 * standing in the box's place is how that is said.
	 *
	 * Its `text` is the source of truth for {@link plan} whenever it is set;
	 * `pasted` is kept untouched underneath, so removing the file gives back
	 * whatever was in the box before.
	 */
	let sourceFile = $state<{ name: string; text: string } | undefined>(undefined);
	/**
	 * The recording the subtitles were written for, if the learner has it.
	 *
	 * Optional in every sense: an import with no file is the ordinary text the
	 * reader has always shown, and the only thing kept about a file that *is*
	 * chosen is its name.
	 */
	let mediaFile = $state<File | undefined>(undefined);
	/**
	 * The other kind of recording: a link to the video the subtitles came from.
	 *
	 * The two are **exclusive** — a text has one recording, and offering a file
	 * *and* a link would be asking which of two answers to the same question
	 * counts. Choosing either clears the other, so what is on screen is always
	 * what would be stored.
	 */
	let mediaLink = $state('');
	/** The file input, so choosing a link can visibly empty it. */
	let mediaInput = $state<HTMLInputElement | null>(null);
	/**
	 * The composer's job in flight, if any — read from the task runner rather
	 * than kept here, so it is still right after the learner has left and come
	 * back, and so the tray can show the same job elsewhere.
	 */
	const composing = $derived(
		taskStore.running.find((task) => task.kind === 'read-generate' || task.kind === 'read-annotate')
	);
	/** One flag for both doors — a page that is mid-call has nothing else to do. */
	const busy = $derived(composing !== undefined);
	let composeError = $state('');

	/**
	 * Whether this page has been left. A composer task outlives the page, and
	 * the one thing it must not do from the shelf is `goto` into a session the
	 * learner has since started — so the text is opened only while this page
	 * is still the one on screen, and otherwise simply waits in the library.
	 */
	let left = false;
	onDestroy(() => {
		left = true;
	});

	const dates = new Intl.DateTimeFormat(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric'
	});

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		Promise.all([getProfile(), getAllItems(), getTexts()])
			.then(([loadedProfile, loadedItems, loadedTexts]) => {
				if (cancelled) return;
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
				if (!loadedProfile) return;
				profile = loadedProfile;
				items = loadedItems;
				texts = loadedTexts;
				mockMode = isMockMode();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open your library.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/**
	 * What the text on the way in actually is, worked out once and used by every
	 * line that describes it and by the button that spends the money.
	 *
	 * There is one door, not two: the learner pastes or uploads whatever they have
	 * and the page recognises it. A subtitle file is un-cued back into sentences
	 * (`cuesToSentences`) and keeps its timings; anything else is prose and is
	 * simply split. **One `$derived` over one source**, which is what keeps the
	 * card, the counter, the button's disabled state and the import from ever
	 * disagreeing about what is being sent — the source is the uploaded file if
	 * there is one and the box otherwise, and nothing downstream asks which.
	 */
	interface ImportPlan {
		/** Absent for ordinary prose — the existing path. */
		format?: SubtitleFormat;
		cues: number;
		/** How much media the cues span, in milliseconds. Zero without cues. */
		durationMs: number;
		sentences: string[];
		/** Index-aligned with `sentences`; absent unless this came from subtitles. */
		timings?: { start: number; end: number }[];
		/** What counts against the ceiling: the text that will be sent. */
		chars: number;
		calls: number;
	}

	const plan = $derived.by((): ImportPlan => {
		const source = sourceFile?.text ?? pasted;
		const format = detectSubtitleFormat(source);

		if (format) {
			const cues = parseSubtitles(source);
			const timed = cuesToSentences(cues);
			const sentences = timed.map((sentence) => sentence.text);
			return {
				format,
				cues: cues.length,
				// The furthest point any cue reaches rather than the last cue's end:
				// the two are the same in every well-formed file, and a `reduce` says
				// so without trusting the order.
				durationMs: cues.reduce((furthest, cue) => Math.max(furthest, cue.end), 0),
				sentences,
				timings: timed.map(({ start, end }) => ({ start, end })),
				chars: sentences.reduce((total, sentence) => total + sentence.length, 0),
				calls: importCallCount(sentences)
			};
		}

		const sentences = splitSentences(source);
		return {
			cues: 0,
			durationMs: 0,
			sentences,
			chars: source.length,
			calls: importCallCount(sentences)
		};
	});

	const overCap = $derived(plan.chars > MAX_IMPORT_TOTAL_CHARS);

	/**
	 * The video the link names, if it names one.
	 *
	 * Derived rather than parsed on submit, because the learner should see what
	 * was understood while there is still a box to correct — a link that turns out
	 * to be a playlist is worth knowing before the import is paid for.
	 */
	const linkId = $derived(videoIdFrom(mediaLink));

	function pickDoor(next: Door) {
		door = next;
		// The other door's failure is not this one's news.
		composeError = '';
	}

	/**
	 * Everything the model may use freely: the garden, plus the words the learner
	 * has marked known.
	 *
	 * That union *is* the point of the mark. A known word needs no gloss and no
	 * card, so handing it over lets a text be written with the function words and
	 * the furniture the learner already reads, instead of only out of the couple
	 * of hundred terms the scheduler happens to be tracking.
	 */
	async function vocabularyNow(): Promise<string[]> {
		const known = await getKnownTerms();
		return [...items.map((item) => item.term), ...known];
	}

	/**
	 * Opens the text a composer task produced, once it has — while this page is
	 * still on screen. The task did the saving; this is only the navigation, and
	 * a failure lands in the box as it always did (and in the tray besides).
	 */
	async function open(done: Promise<TaskOutcome<{ id: string }>>): Promise<void> {
		const outcome = await done;
		if (left) return;
		if (outcome.status === 'done') await goto(`/read/${outcome.result.id}`);
		else if (outcome.status === 'failed') composeError = outcome.error;
	}

	/** Door one: a text written out of the learner's own words. */
	async function generate() {
		if (!profile || busy) return;
		composeError = '';
		const chosen = topic.trim();

		let vocabulary: string[];
		try {
			vocabulary = await vocabularyNow();
		} catch (cause) {
			composeError = cause instanceof Error ? cause.message : 'Could not write a text just now.';
			return;
		}
		// The focus list is the schedule's, so a text is a genuine review and not
		// only pleasant reading — most overdue first, capped where the prompt caps
		// it.
		const { reviewItems } = selectSessionItems(items, {
			now: Date.now(),
			maxItems: MAX_FOCUS_WORDS
		});

		const { done } = startTask('read-generate', {
			profile,
			vocabulary,
			focus: reviewItems.map((item) => ({ term: item.term, meaning: item.meaning })),
			...(chosen ? { topic: chosen } : {})
		});
		await open(done);
	}

	/**
	 * A file the learner uploaded, sorted into one of the two things a file can be.
	 *
	 * **Its content decides, not its extension.** Anything the detector recognises
	 * as cues becomes an object — a card that states what it holds, because
	 * nobody wants a thousand timestamps in a textarea — and anything else *is* a
	 * paste and goes into the box, where it can be read and edited like the text
	 * it is. So a `.txt` that turns out to be an SRT is still a subtitle file, and
	 * an `.srt` full of prose is still prose; the learner never has to know which
	 * door they used.
	 */
	async function uploadFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared straight away, so choosing the same file twice still fires.
		input.value = '';
		if (!file) return;

		composeError = '';
		try {
			const text = await file.text();
			if (detectSubtitleFormat(text)) sourceFile = { name: file.name, text };
			else {
				// Prose: the box is where it belongs, and it replaces whatever object
				// was standing in for it.
				sourceFile = undefined;
				pasted = text;
			}
		} catch {
			composeError = 'Could not read that file.';
		}
	}

	/** Puts the box back, with whatever was in it before the file arrived. */
	function dropSource() {
		sourceFile = undefined;
		composeError = '';
	}

	/**
	 * `mm:ss`, or `h:mm:ss` for anything long enough to need it.
	 *
	 * Local to the page because it is presentation, like the date formatter above:
	 * how long a recording runs is not a fact `$lib/reading` has an opinion about.
	 */
	function clock(ms: number): string {
		const total = Math.round(ms / 1000);
		const seconds = `${total % 60}`.padStart(2, '0');
		const minutes = Math.floor(total / 60) % 60;
		const hours = Math.floor(total / 3600);
		return hours > 0
			? `${hours}:${`${minutes}`.padStart(2, '0')}:${seconds}`
			: `${minutes}:${seconds}`;
	}

	/**
	 * The recording, chosen beside the subtitles that describe it.
	 *
	 * Held only in memory until the import lands. Nothing is read from it here —
	 * a video is hundreds of megabytes and the app wants none of it, only the
	 * handle and, for the store, the name.
	 */
	function chooseRecording(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		mediaFile = input.files?.[0];
		// A text has one recording: the file the learner just chose is the answer,
		// so the link stops being one.
		if (mediaFile) mediaLink = '';
	}

	/**
	 * The other half of the same choice — a link to the video instead of a copy of
	 * it.
	 *
	 * Written out rather than `bind:value`, because clearing the file input is
	 * part of the same keystroke: an `<input type="file">` cannot be emptied by
	 * assigning state (the browser owns its value), so the element is asked
	 * directly, and doing that in the handler keeps the order of the two obvious.
	 */
	function enterLink(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		mediaLink = input.value;
		if (input.value.trim() === '') return;
		mediaFile = undefined;
		if (mediaInput) mediaInput.value = '';
	}

	/** Door two: a text the learner imported, cut here and annotated there. */
	async function add() {
		if (!profile || busy) return;

		const { sentences, timings } = plan;
		if (sentences.length === 0) {
			composeError = 'There is nothing to read in that yet.';
			return;
		}
		if (overCap) {
			composeError = 'That is more than one import can carry — import a shorter piece.';
			return;
		}

		composeError = '';
		const own = title.trim();

		let vocabulary: string[];
		try {
			vocabulary = await vocabularyNow();
		} catch (cause) {
			composeError = cause instanceof Error ? cause.message : 'Could not annotate that text.';
			return;
		}

		// A reference and never the thing itself: an id for YouTube, and for a
		// file only its name and type — the file never leaves this tab. Guarded
		// on `timings` as well, because a media reference on a text whose
		// sentences have no offsets would point at a recording nothing could
		// follow. The link wins where both are somehow set; the two inputs clear
		// each other, so that is a tie that should not arise.
		const media: ReadingMedia | undefined = !timings
			? undefined
			: linkId
				? { kind: 'youtube', videoId: linkId }
				: mediaFile
					? {
							kind: 'file',
							name: mediaFile.name,
							...(mediaFile.type ? { type: mediaFile.type } : {})
						}
					: undefined;

		// The task zips the timings back on and does the saving; the recording
		// rides along so it can be remembered against the id the task mints.
		const { done } = startTask('read-annotate', {
			profile,
			vocabulary,
			sentences,
			...(timings ? { timings } : {}),
			...(own ? { title: own } : {}),
			...(media ? { media } : {}),
			...(media?.kind === 'file' && mediaFile ? { file: mediaFile } : {})
		});
		await open(done);
	}
</script>

<svelte:head>
	<title>Sapling · Media</title>
</svelte:head>

<main class="shell shell-broad">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else}
		<div class="spread">
			<header class="topbar spread-full ll-rise">
				<a class="back" href="/" aria-label="Back to home">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
					</svg>
				</a>
				<div class="identity">
					<p class="eyebrow">Sapling</p>
					<h1>Media</h1>
				</div>
			</header>

			{#if mockMode}
				<p class="mock-hint spread-full">
					<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
						<circle cx="12" cy="12" r="8.4" />
						<path d="M12 7.8v4.6" />
						<path d="M12 16.1h.01" />
					</svg>
					<span>
						No API key configured — texts come from a fixed offline sample, and a pasted one gets
						placeholder translations.
					</span>
				</p>
			{/if}

			<!-- Doing. First in source order, so the phone meets the composer before
			     a shelf that may well be empty. -->
			<section class="card compose-card ll-rise" style="animation-delay: 120ms">
				<div class="doors" role="group" aria-label="Where the text comes from">
					<button
						type="button"
						class="door"
						class:is-on={door === 'write'}
						aria-pressed={door === 'write'}
						disabled={busy}
						onclick={() => pickDoor('write')}
					>
						Write one for me
					</button>
					<button
						type="button"
						class="door"
						class:is-on={door === 'paste'}
						aria-pressed={door === 'paste'}
						disabled={busy}
						onclick={() => pickDoor('paste')}
					>
						Import your own
					</button>
				</div>

				{#if door === 'write'}
					<label class="field tight">
						<span class="label">What about?</span>
						<input
							class="input"
							type="text"
							placeholder="Leave it blank and I'll choose"
							maxlength={MAX_TOPIC_CHARS}
							disabled={busy}
							bind:value={topic}
							onkeydown={(event) => {
								if (event.key === 'Enter') void generate();
							}}
						/>
					</label>

					<div class="examples">
						{#each EXAMPLE_TOPICS as example (example)}
							<button
								type="button"
								class="example-chip"
								disabled={busy}
								onclick={() => (topic = example)}
							>
								{example}
							</button>
						{/each}
					</div>

					<button
						type="button"
						class="btn btn-primary btn-block go"
						disabled={busy}
						onclick={() => void generate()}
					>
						{busy ? 'Writing…' : composeError ? 'Try again' : 'Generate'}
					</button>

					<!-- An empty garden is allowed through: the model still writes
					     something readable at the learner's level. It just has nothing of
					     theirs to build from, which is worth saying once here rather than
					     discovering in the text. -->
					<p class="hint">
						{#if items.length === 0}
							Texts get much better once there are words in your garden — this one will be written
							from scratch.
						{:else}
							Written from your {items.length} word{items.length === 1 ? '' : 's'}, around whatever
							is due.
						{/if}
					</p>
				{:else}
					<label class="field">
						<span class="label">Title</span>
						<input
							class="input"
							type="text"
							placeholder="Optional — I'll name it otherwise"
							disabled={busy}
							bind:value={title}
						/>
					</label>

					<!-- The text source: the box, or the file standing in its place. Never
					     both — a file that poured itself into the textarea is what this
					     replaces, and one of the two being *gone* is how the page says
					     which one is the source. -->
					{#if sourceFile}
						<div class="field tight">
							<p class="label">The text</p>
							<div class="source-card ll-rise">
								<svg class="ico source-mark" viewBox="0 0 24 24" aria-hidden="true">
									<rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2.2" />
									<path d="M3.6 9.3h16.8M8.1 4.8v4.5M15.9 4.8v4.5" />
									<path d="M8.4 13.4h7.2M8.4 16.1h4.4" />
								</svg>
								<div class="source-id">
									<p class="source-kind">
										{plan.format ? FORMAT_NAMES[plan.format] : 'Uploaded file'}
									</p>
									<p class="source-name">{sourceFile.name}</p>
									<!-- Everything the file turned out to hold, in one line: the
									     learner handed over cues and gets back sentences, which is the
									     whole transformation this page performs. -->
									<p class="source-facts">
										{plan.cues} cue{plan.cues === 1 ? '' : 's'} · {plan.sentences.length} sentence{plan
											.sentences.length === 1
											? ''
											: 's'}{plan.durationMs > 0 ? ` · ${clock(plan.durationMs)}` : ''} · about {plan.calls}
										call{plan.calls === 1 ? '' : 's'}
									</p>
								</div>
								<button
									type="button"
									class="source-drop"
									aria-label="Remove {sourceFile.name}"
									disabled={busy}
									onclick={dropSource}
								>
									<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
										<path d="m7 7 10 10M17 7 7 17" />
									</svg>
								</button>
							</div>
							{#if pasted.trim()}
								<p class="hint">
									What you typed is still here — remove the file and it comes back.
								</p>
							{/if}
						</div>
					{:else}
						<label class="field tight paste-field">
							<span class="label">The text</span>
							<textarea
								class="input paste-input"
								rows="8"
								placeholder="An article, a song, a transcript you copied…"
								disabled={busy}
								bind:value={pasted}></textarea>
						</label>

						<!-- The browser's own file control is the ugliest thing on the page
						     and says "No file chosen" where a verb belongs, so the input is
						     hidden inside its label and the label is the affordance. Dashed,
						     because in this journal a dashed edge is where something is meant
						     to be put. -->
						<label class="file-btn">
							<input
								class="file-real"
								type="file"
								accept=".srt,.vtt,.txt"
								disabled={busy}
								onchange={(event) => void uploadFile(event)}
							/>
							<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M12 16.4V4.9" />
								<path d="m7.6 9.3 4.4-4.4 4.4 4.4" />
								<path d="M4.6 15.1v2.8a1.6 1.6 0 0 0 1.6 1.6h11.6a1.6 1.6 0 0 0 1.6-1.6v-2.8" />
							</svg>
							<span>Or upload a file — subtitles, or plain text</span>
						</label>
					{/if}

					<!-- Cost, before anything is spent on it: an import is the one action
					     here whose price is invisible until it has been paid. The card
					     above already states an uploaded file's counts, so this side only
					     speaks for what is in the box. -->
					<div class="cost">
						{#if !sourceFile && plan.sentences.length > 0}
							<p class="plan">
								{#if plan.format}{FORMAT_NAMES[plan.format]} · {plan.cues} cue{plan.cues === 1
										? ''
										: 's'} ·
								{/if}{plan.sentences.length} sentence{plan.sentences.length === 1 ? '' : 's'} · about
								{plan.calls}
								call{plan.calls === 1 ? '' : 's'}
							</p>
						{/if}
						<p
							class="counter"
							class:near={plan.chars > MAX_IMPORT_TOTAL_CHARS * 0.9}
							class:over={overCap}
						>
							{plan.chars} / {MAX_IMPORT_TOTAL_CHARS}
						</p>
					</div>

					<!-- The button below is disabled in both these cases, so this is the
					     only place the reason can be given: a dead control that does not
					     say why is the failure. -->
					{#if overCap}
						<p class="hint over-note">
							That is more than one import can carry — import a shorter piece.
						</p>
					{:else if sourceFile && plan.sentences.length === 0}
						<p class="hint over-note">There is nothing to read in that file.</p>
					{/if}

					<!--
					  The recording. Always here, never conjured: a control that appears
					  only once a paste happens to validate is a feature nobody knows the
					  app has. Without timings there is nothing for a recording to be in
					  step with, so the group is disabled and says so — a `<fieldset>`,
					  which makes every control inside it inert in one attribute and needs
					  no per-input bookkeeping.
					-->
					<fieldset class="group" disabled={busy || !plan.format}>
						<legend class="group-legend">
							Recording <span class="group-note">optional</span>
						</legend>

						<label class="file-btn">
							<input
								class="file-real"
								type="file"
								accept="video/*,audio/*"
								bind:this={mediaInput}
								onchange={chooseRecording}
							/>
							<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
								<rect x="3.4" y="6.2" width="12.4" height="11.6" rx="2" />
								<path d="m15.8 12 4.8-3.2v6.4L15.8 12z" />
							</svg>
							<!-- The control stays a verb and the line below says what is
							     attached: a button that renames itself to a filename is a
							     button that has stopped saying what pressing it does. -->
							<span>Choose a video or audio file</span>
						</label>

						<!-- Or the video where it lives. One recording per text, so the two
						     clear each other rather than both being sent. -->
						<label class="field link-field">
							<span class="link-label">or a YouTube link</span>
							<input
								class="input"
								type="url"
								inputmode="url"
								placeholder="https://youtu.be/…"
								value={mediaLink}
								oninput={enterLink}
							/>
						</label>

						<p class="hint media-hint">
							{#if !plan.format}
								Import subtitles and the text can follow its recording, line by line.
							{:else if linkId}
								Video <strong>{linkId}</strong> plays beside the text, from YouTube.
							{:else if mediaLink.trim()}
								That is not a YouTube link — paste the address of a video, or its id.
							{:else if mediaFile}
								<strong>{mediaFile.name}</strong> plays beside the text. Only its name is kept — the file
								stays on your device, so you'll pick it again next time you open this.
							{:else}
								Add the recording and the text follows along with it. A file never leaves this
								device — only its name is kept.
							{/if}
						</p>
					</fieldset>

					<button
						type="button"
						class="btn btn-primary btn-block go"
						disabled={busy || overCap || plan.sentences.length === 0}
						onclick={() => void add()}
					>
						{#if busy}
							Annotating… details in the task tray
						{:else if composeError}
							Try again
						{:else}
							Add
						{/if}
					</button>

					<p class="hint">
						Kept word for word. Only the readings, the translations and the glossary are added — and
						a subtitle file keeps the time each line is spoken.
					</p>
				{/if}

				{#if composeError}
					<p class="error" role="alert">{composeError}</p>
				{/if}
			</section>

			<!-- State: the shelf. -->
			<section class="shelf ll-rise" style="animation-delay: 180ms">
				<h2 class="shelf-head">Your media</h2>
				{#if texts.length === 0}
					<p class="hint empty">
						Nothing on the shelf yet — the first thing you write or import lands here.
					</p>
				{:else}
					<ul class="texts">
						{#each texts as text (text.id)}
							<li>
								<a class="text-row" href="/read/{text.id}">
									<span class="text-title">{text.title}</span>
									<span class="text-meta">
										<span class="badge badge-{text.source}">
											{text.source === 'generated' ? 'written' : 'imported'}
										</span>
										<span>{dates.format(text.createdAt)}</span>
										<span
											>{text.sentences.length} sentence{text.sentences.length === 1
												? ''
												: 's'}</span
										>
									</span>
								</a>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{/if}
</main>

<style>
	/* Width and the side gutter belong to the global `.shell`/`.shell-broad`
	   pair; only the vertical rhythm is this route's. */
	.shell {
		padding-block: 1.5rem 4rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
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
		min-width: 0;
	}

	.eyebrow {
		margin: 0 0 0.05rem;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.55rem;
		line-height: 1.1;
	}

	/* A pencilled-in note in the margin, not a banner — same as `/converse`. */
	.mock-hint {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		margin: 0;
		padding: 0.6rem 0.75rem;
		border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border-strong));
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--accent-soft) 70%, transparent);
		color: var(--text);
		font-size: 0.82rem;
		line-height: 1.4;
	}

	.mock-hint .ico {
		width: 1.05rem;
		height: 1.05rem;
		margin-top: 0.06rem;
		color: var(--accent);
	}

	/* The composer ------------------------------------------------------- */

	/* Two doors onto one shelf, so they are a segmented control rather than two
	   buttons: the choice is which composer is showing, not which feature the
	   learner is using. */
	.doors {
		display: flex;
		gap: 0.25rem;
		margin-bottom: 1.1rem;
		padding: 0.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.door {
		flex: 1 1 0;
		min-width: 0;
		padding: 0.5rem 0.6rem;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.85rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			background 0.15s ease,
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.door:hover:not(:disabled):not(.is-on) {
		color: var(--text);
	}

	.door.is-on {
		border-color: var(--border);
		background: var(--surface);
		color: var(--text);
	}

	.door:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.door:disabled {
		cursor: default;
		opacity: 0.6;
	}

	/* The field a control follows immediately — the topic above its examples, the
	   text above where it came from. Named rather than `:last-of-type`, which
	   picked a different element depending on which branch was rendering. */
	.field.tight {
		margin-bottom: 0.75rem;
	}

	.paste-input {
		min-height: 9rem;
		line-height: 1.5;
		resize: vertical;
	}

	/* The uploaded file, as an object -------------------------------------- */

	/*
	  A card in the box's place, wearing the same clothes as a text on the shelf:
	  this *is* one, a few seconds early. `--surface-alt` rather than `--surface`
	  so it reads as something laid on the page rather than another sheet of it.
	*/
	.source-card {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		padding: 0.85rem 0.9rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-alt);
	}

	.source-mark {
		margin-top: 0.15rem;
		color: color-mix(in srgb, var(--primary) 70%, var(--text-muted));
	}

	.source-id {
		flex: 1 1 auto;
		min-width: 0;
	}

	.source-kind {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: color-mix(in srgb, var(--accent) 65%, var(--text-muted));
	}

	/* The display face, because a file the learner uploaded is a title, not a
	   parameter — the shelf rows below name their texts the same way. */
	.source-name {
		margin: 0.1rem 0 0;
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		line-height: 1.25;
		overflow-wrap: anywhere;
	}

	/* What the file turned out to hold. Tabular figures so the numbers sit still
	   while the learner swaps one file for another. */
	.source-facts {
		margin: 0.3rem 0 0;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.source-drop {
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
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.source-drop:hover:not(:disabled) {
		border-color: var(--border-strong);
		background: var(--surface);
		color: var(--text);
	}

	.source-drop:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.source-drop:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Uploading a file ----------------------------------------------------- */

	/*
	  The browser draws a file input as a small grey button and the words "No file
	  chosen", which is the least inviting thing on the page and says nothing
	  about what to upload. So the input is hidden *inside* its own label — still
	  focusable, still the accessible name — and the label is the affordance: a
	  dashed slot, which in this journal is where something is meant to be put.
	*/
	.file-btn {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		width: 100%;
		margin-bottom: 0.9rem;
		padding: 0.7rem 0.85rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface-alt) 55%, transparent);
		color: var(--text-muted);
		font-size: 0.85rem;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.file-btn span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* A `<label>` is never `:disabled` itself, but it can be the label *of*
	   something that is — which covers both pickers, the one the fieldset turns
	   off and the one `busy` does. Without this the slot still lights up under a
	   cursor that cannot do anything with it. */
	.file-btn:not(:has(:disabled)):hover {
		border-color: var(--text-muted);
		background: var(--surface-alt);
		color: var(--text);
	}

	.file-btn:has(:disabled) {
		cursor: not-allowed;
	}

	/* The ring belongs to the label, since that is what the eye sees; the input
	   inside it is what actually holds focus. */
	.file-btn:focus-within {
		border-color: var(--accent);
		box-shadow: var(--ring);
	}

	/* Hidden from the eye, not from the keyboard or the accessibility tree —
	   `display: none` would take it out of the tab order and break the label. */
	.file-real {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* The recording group ---------------------------------------------------- */

	/*
	  A real `<fieldset>`, for the one thing it does that nothing else does:
	  `disabled` on it makes every control inside inert at once. That is what
	  lets the group be *present but off* while the text has no timings, instead
	  of appearing out of nowhere the moment a paste happens to parse.
	*/
	.group {
		/* A fieldset's default `min-inline-size: min-content` is the one piece of
		   its old browser behaviour that still bites: it refuses to be narrower
		   than its widest child and would push the card past the phone. */
		min-inline-size: 0;
		margin: 0 0 0.9rem;
		padding: 0.9rem 0.9rem 0.2rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--surface-alt) 35%, transparent);
		transition: opacity 0.2s ease;
	}

	.group:disabled {
		opacity: 0.62;
	}

	/* A `<legend>` renders inside the top border unless it is told to be a block;
	   here the border is the group's own edge and the label belongs above the
	   controls, inside it. A browser that ignores this puts the label on the
	   edge instead, which is the ordinary fieldset look and no worse. */
	.group-legend {
		display: block;
		width: 100%;
		margin-bottom: 0.6rem;
		padding: 0;
		font-size: 0.74rem;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.group-note {
		margin-left: 0.35rem;
		font-weight: 400;
		letter-spacing: 0.04em;
		text-transform: none;
		opacity: 0.8;
	}

	.link-field {
		margin-bottom: 0.7rem;
	}

	.media-hint {
		margin: 0 0 0.75rem;
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}

	.link-label {
		display: block;
		margin-bottom: 0.3rem;
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--text-muted);
	}

	/*
	  What is about to be sent and what it will cost, on one line under the source
	  — whichever source that is. The two ends of a row that wraps: on a phone
	  they stack in source order, and no breakpoint has to be spent saying so.
	*/
	.cost {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.2rem 1rem;
		margin-bottom: 0.9rem;
	}

	/* Tucked under the box's right edge, where a word count belongs. */
	.counter {
		margin: 0 0 0 auto;
		text-align: right;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.counter.near {
		color: var(--accent);
		font-weight: 700;
	}

	.counter.over {
		color: var(--danger);
		font-weight: 700;
	}

	/* Says why the button below is dead, which is the only thing a disabled
	   control cannot say for itself. */
	.over-note {
		margin: -0.5rem 0 0.9rem;
		color: var(--danger);
	}

	/* What the paste was recognised as. A note, not a warning: it is the same
	   door either way, and the learner only needs to see that the app read the
	   file rather than the timestamps. */
	.plan {
		margin: 0;
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.examples {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-bottom: 1.1rem;
	}

	.example-chip {
		padding: 0.35rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			color 0.15s ease;
	}

	.example-chip:hover:not(:disabled) {
		border-color: var(--text-muted);
		color: var(--text);
	}

	.example-chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.go {
		padding: 0.85rem 1.4rem;
	}

	.error {
		margin: 0.9rem 0 0;
		padding: 0.65rem 0.85rem;
		border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
		font-size: 0.9rem;
		font-weight: 700;
	}

	/* The shelf ----------------------------------------------------------- */

	.shelf-head {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}

	/* Not a card: a run of rows reads as a list of things, and a card around it
	   would claim the shelf is one object. */
	.texts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.text-row {
		display: block;
		padding: 0.85rem 1rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.text-row:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.text-row:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.text-title {
		display: block;
		font-family: var(--font-display);
		font-size: 1.02rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.text-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.6rem;
		margin-top: 0.3rem;
		font-size: 0.78rem;
		font-weight: 400;
		color: var(--text-muted);
	}

	/* Where a text came from, in one word. The two are peers — an imported text is
	   not a lesser one — so they differ in hue, not in weight. */
	.badge {
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.badge-generated {
		background: var(--primary-soft);
		color: var(--primary-strong);
	}

	.badge-imported {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.empty {
		margin: 0;
		padding: 1rem 0;
		text-wrap: balance;
	}

	@media (max-width: 400px) {
		.doors {
			flex-direction: column;
		}
	}
</style>
