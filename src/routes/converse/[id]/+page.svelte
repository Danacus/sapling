<!--
  One stored conversation: a role-played exchange with an LLM teacher, resumed
  where it was left.

  The scene and the transcript are rows in the database, derived from the
  append-only log — which suits a conversation exactly, because a conversation
  *is* append-only: nothing here is ever edited, there is no regenerate, and the
  only write is one more exchange on the end.

  **The unit of persistence is the exchange**, a learner message and the teacher
  turn that answered it. A message whose reply failed stays in `$state` and is
  never written, so stored history always ends on a teacher line — which is what
  the dialogue replay in `$lib/conversation` resumes from. This page owns every
  write; the module itself never touches the database.

  The layout is modelled on `/chat` (same bubbles, composer, error/retry), with
  the three things this mode adds: the scenario card pinned above the
  transcript, a translation the learner has to ask for, and corrections marked
  inline on their own bubble — which arrive one turn late, because the teacher
  only sees a message once it has been sent.

  A learner typing romanization sees their own sentence in the target script
  under their bubble whether or not it needed correcting: the script is the thing
  being learned, and making it the reward for a mistake is exactly backwards.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { tick } from 'svelte';

	import { appendDictation, dictationAvailable, listen } from '$lib/asr';
	import type { DictationSession } from '$lib/asr';
	import { alignedForm, correctionSpans, sendTurn, spanGap } from '$lib/conversation';
	import type { ConversationTurn, Scenario } from '$lib/conversation';
	import { addExchange, getConversation, getProfile } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import { stopSpeaking } from '$lib/tts';
	import type { Profile } from '$lib/types';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	let loading = $state(true);
	let loadError = $state('');
	/** The conversation is not here — deleted on this device or on another one. */
	let missing = $state(false);
	let profile = $state<Profile | undefined>(undefined);
	let mockMode = $state(false);

	let conversationId = $state('');
	let scenario = $state<Scenario | null>(null);

	let turns = $state<ConversationTurn[]>([]);
	/**
	 * How many exchanges are on disk, and therefore the index the next one takes.
	 *
	 * Counted rather than derived from `turns.length`, because the two differ
	 * whenever a send has failed: the learner's bubble is in `turns` and nothing
	 * was written for it.
	 */
	let stored = $state(0);

	let input = $state('');
	let busy = $state(false);
	/** Set only when the last send failed — the failed learner turn stays in `turns`. */
	let pendingError = $state<{ text: string; message: string } | null>(null);
	/** Teacher turns whose translation the learner asked to see, by index. */
	let revealed = $state<Record<number, boolean>>({});

	// -- Dictation ------------------------------------------------------------
	//
	// The microphone is an *input method*: what it hears lands in the composer,
	// where the learner reads it and presses Send. So a misheard word is a typo
	// they fix, never a mistake the teacher corrects them for — and the whole
	// correction pipeline goes on aligning against a message they endorsed.
	//
	// Recognition is not in every browser (see `$lib/asr`), so the control is
	// rendered only where it works rather than degrading to a dead button.

	let micSupported = $state(false);
	let recording = $state(false);
	let micError = $state('');
	let session: DictationSession | undefined;
	/** The composer as it stood when the mic opened; every interim re-splices onto it. */
	let dictationBase = '';

	let messagesEl: HTMLDivElement | undefined = $state();
	let textareaEl: HTMLTextAreaElement | undefined = $state();

	$effect(() => {
		if (!browser) return;

		micSupported = dictationAvailable();

		const id = page.params.id ?? '';
		let cancelled = false;
		loading = true;
		loadError = '';
		missing = false;

		Promise.all([getProfile(), getConversation(id)])
			.then(([loadedProfile, loaded]) => {
				if (cancelled) return;
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
				if (!loadedProfile) return;

				profile = loadedProfile;
				mockMode = isMockMode();
				loading = false;

				if (!loaded) {
					missing = true;
					return;
				}

				conversationId = loaded.conversation.id;
				scenario = loaded.conversation.scenario;
				stored = loaded.exchanges.length;
				// The stored shape *is* the rendered shape — the two type families are
				// structurally identical (see `$lib/types`) — so resuming is a flatten
				// and nothing more.
				turns = loaded.exchanges.flatMap((exchange) =>
					exchange.learner ? [exchange.learner, exchange.teacher] : [exchange.teacher]
				);
				focusComposer();
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open that conversation.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	// Sticks the transcript to the bottom on every new turn or state change that
	// adds a row.
	$effect(() => {
		turns.length;
		busy;
		pendingError;
		if (!messagesEl) return;
		void tick().then(() => {
			if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
		});
	});

	function autoGrow() {
		if (!textareaEl) return;
		textareaEl.style.height = 'auto';
		textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 5 * 24 + 24)}px`;
	}

	function focusComposer() {
		void tick().then(() => textareaEl?.focus());
	}

	/** Drops an open microphone, and any line still being spoken, on the way out. */
	$effect(() => () => {
		session?.abort();
		stopSpeaking();
	});

	/**
	 * Opens the mic, or closes it if it is already open. Interim results stream
	 * into the composer so the learner can see they are being heard; each one
	 * replaces the last by re-splicing onto {@link dictationBase}.
	 */
	function toggleMic() {
		if (recording) {
			session?.stop();
			return;
		}
		if (busy) return;

		micError = '';
		dictationBase = input;

		const started = listen(profile?.targetLanguage, {
			onTranscript: (text) => {
				input = appendDictation(dictationBase, text);
				void tick().then(autoGrow);
			},
			onEnd: (message) => {
				recording = false;
				session = undefined;
				if (message) micError = message;
				focusComposer();
			}
		});

		if (!started) {
			micError = 'Dictation could not start. Type your reply instead.';
			return;
		}

		session = started;
		recording = true;
	}

	/**
	 * The one round trip: ask, pin the correction onto the learner's bubble,
	 * append the teacher's turn, and only then write the pair.
	 *
	 * The write comes last and covers both halves at once, which is what keeps a
	 * failed send out of the record: there is no half-exchange on disk to
	 * reconcile, just a bubble the learner can retry. Both callers below do
	 * exactly this and differ only in what history they consider sent.
	 */
	async function ask(history: ConversationTurn[], text: string, who: Profile, scene: Scenario) {
		busy = true;
		pendingError = null;

		try {
			const result = await sendTurn(history, scene, text, who);
			const last = turns[turns.length - 1];
			const learner = last?.role === 'learner' ? last : undefined;
			if (learner) {
				if (result.correction) learner.correction = result.correction;
				if (result.heard) learner.heard = result.heard;
			}
			turns = [...turns, result.teacher];

			await addExchange({
				conversationId,
				index: stored,
				...(learner ? { learner } : {}),
				teacher: result.teacher
			});
			stored += 1;
		} catch (cause) {
			pendingError = {
				text,
				message: cause instanceof Error ? cause.message : 'Something went wrong.'
			};
		} finally {
			busy = false;
			focusComposer();
		}
	}

	async function send() {
		const text = input.trim();
		if (!text || busy || !profile || !scenario) return;

		// Sending mid-utterance takes what is already in the composer; the rest of
		// the sentence is not owed a bubble the learner never read.
		session?.abort();
		micError = '';

		const history = [...turns];
		turns = [...turns, { role: 'learner', text }];
		input = '';
		void tick().then(autoGrow);

		await ask(history, text, profile, scenario);
	}

	/** Re-sends the last failed turn with the same history it originally used. */
	async function retry() {
		if (!pendingError || busy || !profile || !scenario) return;
		await ask(turns.slice(0, -1), pendingError.text, profile, scenario);
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}
</script>

<svelte:head>
	<title>Sapling · Conversation</title>
</svelte:head>

<!--
  The learner's sentence in the target script, with its speaker button. Reached
  from both halves of a learner bubble: the corrected sentence, and the
  uncorrected one the teacher simply read back.
-->
{#snippet scriptLine(text: string)}
	<p class="script-line">
		<span>{text}</span>
		<SpeakButton {text} lang={profile?.targetLanguage ?? ''} size="sm" />
	</p>
{/snippet}

<main class="shell shell-wide">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else if missing || !scenario}
		<div class="card gone">
			<h1>This conversation is gone</h1>
			<p class="hint">It was deleted, here or on another device.</p>
			<a class="btn btn-ghost" href="/converse">Back to your conversations</a>
		</div>
	{:else}
		<header class="topbar ll-rise">
			<a class="back" href="/converse" aria-label="Back to your conversations">
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
					<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
				</svg>
			</a>
			<div class="identity">
				<p class="eyebrow">Sapling</p>
				<h1>Conversation</h1>
			</div>
		</header>

		{#if mockMode}
			<p class="mock-hint">
				<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
					<circle cx="12" cy="12" r="8.4" />
					<path d="M12 7.8v4.6" />
					<path d="M12 16.1h.01" />
				</svg>
				<span>
					No API key configured — the conversation is running in offline demo mode, in a fixed
					Spanish scene.
				</span>
			</p>
		{/if}

		<section class="scene ll-rise" aria-label="The scene">
			<p class="scene-setting">{scenario.setting}</p>
			<p class="scene-roles">
				<span>You are <strong>{scenario.learnerRole}</strong>.</span>
				<span>I am <strong>{scenario.teacherRole}</strong>.</span>
			</p>
		</section>

		<div class="messages" bind:this={messagesEl} aria-live="polite">
			{#each turns as turn, index (index)}
				{#if turn.role === 'learner'}
					<div class="row learner-row">
						<div class="bubble learner-bubble">
							{#if turn.correction}
								{@const spans = correctionSpans(turn.text, turn.correction)}
								<!--
								  Spans sit flush against each other: the gap between two of them
								  is the script's, not the template's, so an inserted 有 lands
								  against 你 while an inserted `wil` still gets its space.
								-->
								<span class="marked"
									>{#each spans as span, spanIndex (spanIndex)}{#if spanIndex > 0}{spanGap(
												spans[spanIndex - 1].text,
												span.text
											)}{/if}<span class="span {span.kind}">{span.text}</span>{/each}</span
								>
								{#if alignedForm(turn.text, turn.correction.corrected) !== turn.correction.corrected.text}
									<!--
									  The markup above ran against the reading, because the reading
									  is what they typed. The script itself is the thing being
									  learned, so it is shown rather than left out.
									-->
									{@render scriptLine(turn.correction.corrected.text)}
								{/if}
								{#if turn.correction.note}
									<p class="note">{turn.correction.note}</p>
								{/if}
							{:else}
								{turn.text}
								{#if turn.heard}
									<!--
									  Same line, no mistake behind it: what they typed, in the
									  script. The two branches are exclusive — a correction already
									  carries this sentence — so the script arrives either way and
									  is not something a mistake has to be made to see.
									-->
									{@render scriptLine(turn.heard.text)}
								{/if}
							{/if}
						</div>
					</div>
				{:else}
					<div class="row teacher-row">
						<div class="bubble teacher-bubble">
							<div class="said">
								<span class="said-text">{turn.reply.text}</span>
								<SpeakButton
									text={turn.reply.text}
									lang={profile?.targetLanguage ?? ''}
									size="sm"
								/>
							</div>
							{#if turn.reply.reading}
								<p class="reading">{turn.reply.reading}</p>
							{/if}
							{#if turn.translation}
								{#if revealed[index]}
									<p class="translation">{turn.translation}</p>
								{:else}
									<button
										type="button"
										class="reveal"
										onclick={() => (revealed = { ...revealed, [index]: true })}
									>
										Show translation
									</button>
								{/if}
							{/if}
							{#if turn.actions.length > 0}
								<div class="actions">
									{#each turn.actions as action, actionIndex (actionIndex)}
										<span class={action.ok ? 'chip ok' : 'chip fail'}>
											{#if action.ok}
												<svg class="ico chip-ico" viewBox="0 0 24 24" aria-hidden="true">
													<path d="m5 12.8 4.4 4.4L19 7.6" />
												</svg>
											{:else}
												<svg class="ico chip-ico" viewBox="0 0 24 24" aria-hidden="true">
													<path d="m7 7 10 10M17 7 7 17" />
												</svg>
											{/if}
											{action.summary}
										</span>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			{/each}

			{#if busy}
				<div class="row teacher-row">
					<div class="bubble teacher-bubble typing" role="status" aria-label="Teacher is typing">
						<span class="dot"></span>
						<span class="dot"></span>
						<span class="dot"></span>
					</div>
				</div>
			{/if}

			{#if pendingError}
				<div class="row teacher-row">
					<div class="bubble error-bubble" role="alert">
						<p class="error-text">{pendingError.message}</p>
						<button type="button" class="btn btn-ghost retry-btn" onclick={() => void retry()}>
							Retry
						</button>
					</div>
				</div>
			{/if}
		</div>

		{#if micError}
			<p class="error mic-error" role="alert">{micError}</p>
		{/if}

		<form class="composer" onsubmit={(event) => event.preventDefault()}>
			<textarea
				bind:this={textareaEl}
				class="composer-input"
				rows="1"
				placeholder={recording
					? 'Listening…'
					: `Reply in ${profile?.targetLanguage ?? 'the target language'}…`}
				aria-label="Your reply"
				disabled={busy}
				bind:value={input}
				onkeydown={onComposerKeydown}
				oninput={autoGrow}></textarea>
			{#if micSupported}
				<button
					type="button"
					class="btn btn-ghost mic-btn"
					class:recording
					disabled={busy}
					aria-pressed={recording}
					aria-label={recording ? 'Stop dictating' : 'Dictate your reply'}
					title={recording ? 'Stop dictating' : 'Dictate your reply'}
					onclick={toggleMic}
				>
					<span aria-hidden="true">{recording ? '■' : '🎤'}</span>
				</button>
			{/if}
			<button
				type="button"
				class="btn btn-primary send-btn"
				disabled={busy || !input.trim()}
				onclick={() => void send()}
			>
				Send
			</button>
		</form>
	{/if}
</main>

<style>
	/*
	  Width and the horizontal gutter are the global `.shell`/`.shell-wide`
	  pair's job; what stays scoped is genuinely vertical — pinning the page
	  to the viewport and stacking topbar, scene, transcript and composer inside
	  it.
	*/
	.shell {
		height: 100dvh;
		padding-block: 1.25rem 0;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.loading {
		display: grid;
		place-items: center;
		min-height: 60dvh;
	}

	/* One hand for every icon on this screen, matching the assistant: 24-unit
	   box, hairline stroke, round joins. */
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
		flex: 0 0 auto;
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

	/* A conversation that is not there any more: a card, not an error — nothing
	   went wrong, the thing is simply gone. */
	.gone {
		margin-top: 2rem;
		text-align: center;
	}

	.gone h1 {
		margin: 0 0 0.5rem;
		font-size: 1.35rem;
	}

	.gone .hint {
		margin: 0 0 1.2rem;
	}

	/* A pencilled-in note in the margin, not a banner. */
	.mock-hint {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		flex: 0 0 auto;
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

	/*
	  The scene, written out like the header of a script: what the page is
	  about, before a word of the target language appears. Its setting line is
	  prose, so it keeps the reading measure even though the shell around it is
	  wider — the wider shell is for the transcript, not for this sentence.
	*/
	.scene {
		flex: 0 0 auto;
		max-width: var(--measure);
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--border);
		border-left: 3px solid color-mix(in srgb, var(--primary) 45%, var(--border-strong));
		border-radius: var(--radius-sm);
		background: var(--surface);
	}

	.scene-setting {
		margin: 0 0 0.35rem;
		font-size: 0.92rem;
		line-height: 1.45;
	}

	.scene-roles {
		display: flex;
		flex-wrap: wrap;
		gap: 0.15rem 0.9rem;
		margin: 0;
		color: var(--text-muted);
		font-size: 0.82rem;
	}

	.messages {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.35rem 0.1rem 0.35rem 0.9rem;
		border-left: 1px dashed var(--border-strong);
	}

	.row {
		display: flex;
		animation: ll-rise 0.28s cubic-bezier(0.2, 0.7, 0.3, 1) both;
	}

	.learner-row {
		justify-content: flex-end;
	}

	.teacher-row {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 84%;
		padding: 0.7rem 0.9rem;
		border-radius: var(--radius);
		font-size: 0.95rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}

	.learner-bubble {
		border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
		color: var(--text);
		border-bottom-right-radius: 4px;
	}

	.teacher-bubble {
		background: var(--surface);
		border: 1px solid var(--border);
		border-bottom-left-radius: 4px;
		box-shadow: 0 1px 0 color-mix(in srgb, var(--border) 70%, transparent);
	}

	.said {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
	}

	.said-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.reading {
		margin: 0.2rem 0 0;
		color: var(--text-muted);
		font-size: 0.82rem;
		font-style: italic;
	}

	/* The translation is there when it is wanted and invisible when it is not:
	   reading it should be a decision, not the default. */
	.reveal {
		margin-top: 0.4rem;
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
		margin: 0.4rem 0 0;
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	/*
	  A correction is marked where the mistake was made, in the learner's own
	  bubble — the wrong words struck through, the right ones beside them. Set
	  back to normal wrapping so the markup's own line breaks do not become
	  literal whitespace inside a pre-wrap bubble.
	*/
	.marked {
		white-space: normal;
	}

	.span.removed {
		color: var(--danger);
		text-decoration: line-through;
		text-decoration-thickness: 1px;
	}

	.span.added {
		color: var(--primary-strong);
		font-weight: 700;
	}

	/* The learner's sentence in the target script, under what they actually
	   typed — a correction's rewrite, or the teacher's plain read-back. */
	.script-line {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0.35rem 0 0;
		color: var(--primary-strong);
		font-weight: 600;
		white-space: normal;
	}

	.note {
		margin: 0.45rem 0 0;
		padding-top: 0.4rem;
		border-top: 1px dashed color-mix(in srgb, var(--accent) 40%, var(--border-strong));
		color: var(--text-muted);
		font-size: 0.8rem;
		white-space: normal;
	}

	/* What the teacher filed away, receipted under a stitched rule — the same
	   treatment the assistant's tool calls get. */
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.6rem;
		padding-top: 0.55rem;
		border-top: 1px dashed var(--border-strong);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.32rem;
		padding: 0.22rem 0.6rem;
		border: 1px solid transparent;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 700;
		line-height: 1.35;
	}

	.chip-ico {
		width: 0.82rem;
		height: 0.82rem;
		stroke-width: 2;
	}

	.chip.ok {
		border-color: color-mix(in srgb, var(--primary) 35%, transparent);
		background: var(--primary-soft);
		color: var(--text);
	}

	.chip.ok .chip-ico {
		color: var(--primary-strong);
	}

	.chip.fail {
		border-color: color-mix(in srgb, var(--danger) 35%, transparent);
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	.typing {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.8rem 1rem;
	}

	.dot {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: var(--text-muted);
		animation: dot-pulse 1.1s ease-in-out infinite;
	}

	.dot:nth-child(2) {
		animation-delay: 0.15s;
	}

	.dot:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes dot-pulse {
		0%,
		60%,
		100% {
			opacity: 0.3;
			transform: translateY(0);
		}
		30% {
			opacity: 1;
			transform: translateY(-2px);
		}
	}

	.error-bubble {
		background: color-mix(in srgb, var(--danger) 12%, var(--surface));
		border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
		border-bottom-left-radius: 4px;
	}

	.error-text {
		margin: 0 0 0.5rem;
		color: var(--danger);
		font-weight: 700;
		font-size: 0.9rem;
	}

	.retry-btn {
		padding: 0.35rem 0.85rem;
		border-color: color-mix(in srgb, var(--danger) 40%, transparent);
		color: var(--danger);
		font-size: 0.8rem;
	}

	.retry-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 12%, transparent);
		color: var(--danger);
	}

	.composer {
		flex: 0 0 auto;
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		padding: 0.75rem 0 calc(0.75rem + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border);
	}

	.composer-input {
		flex: 1 1 auto;
		min-width: 0;
		max-height: 8rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		line-height: 1.35;
		resize: none;
		box-shadow: inset 0 1px 2px rgb(60 50 20 / 6%);
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.composer-input::placeholder {
		color: var(--text-muted);
		opacity: 0.7;
	}

	.composer-input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--ring);
	}

	.composer-input:disabled {
		opacity: 0.6;
	}

	.send-btn {
		flex: 0 0 auto;
		padding: 0.7rem 1.2rem;
	}

	.mic-btn {
		flex: 0 0 auto;
		padding: 0.7rem 0.8rem;
		line-height: 1.35;
	}

	/* Recording is a state the learner has to be able to see at a glance, since
	   the only other cue is the browser's own tab indicator. */
	.mic-btn.recording {
		border-color: var(--danger);
		color: var(--danger);
		animation: pulse 1.4s ease-in-out infinite;
	}

	.mic-error {
		margin-bottom: 0.5rem;
	}

	@keyframes pulse {
		50% {
			opacity: 0.55;
		}
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

	/* Everything this component animates is decoration; none of it survives a
	   reduced-motion preference. */
	@media (prefers-reduced-motion: reduce) {
		.row {
			animation: none;
		}

		.dot {
			animation: none;
			opacity: 0.6;
		}

		/* The colour still says "recording"; only the throb goes. */
		.mic-btn.recording {
			animation: none;
		}
	}

	@media (max-width: 480px) {
		.shell {
			padding: 1rem 0.75rem 0;
		}

		.messages {
			padding-left: 0.7rem;
		}
	}
</style>
