<!--
  Conversation mode: a role-played exchange with an LLM teacher.

  Ephemeral like the assistant screen — the scene and the transcript live in
  this component's `$state` and a reload starts a fresh conversation. The only
  thing a session leaves behind is vocabulary the teacher filed through
  `add_words`, which is why those calls are receipted under the reply exactly as
  they are on the chat page.

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
	import { tick } from 'svelte';

	import { alignedForm, correctionSpans, sendTurn, startConversation } from '$lib/conversation';
	import type { ConversationTurn, Scenario } from '$lib/conversation';
	import { getProfile } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import type { Profile } from '$lib/types';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	const EXAMPLE_TOPICS = ['Ordering coffee', 'Asking for directions', 'Arguing about football'];

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let mockMode = $state(false);

	let topic = $state('');
	let scenario = $state<Scenario | null>(null);
	let starting = $state(false);
	let startError = $state('');

	let turns = $state<ConversationTurn[]>([]);
	let input = $state('');
	let busy = $state(false);
	/** Set only when the last send failed — the failed learner turn stays in `turns`. */
	let pendingError = $state<{ text: string; message: string } | null>(null);
	/** Teacher turns whose translation the learner asked to see, by index. */
	let revealed = $state<Record<number, boolean>>({});

	let messagesEl: HTMLDivElement | undefined = $state();
	let textareaEl: HTMLTextAreaElement | undefined = $state();

	$effect(() => {
		if (!browser) return;

		let cancelled = false;
		loading = true;
		loadError = '';

		getProfile()
			.then((loaded) => {
				if (cancelled) return;
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
				if (loaded) {
					profile = loaded;
					mockMode = isMockMode();
					loading = false;
				}
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not load your profile.';
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

	/** The setup call. Its failure is its own, so the start screen can offer another go. */
	async function start() {
		if (!profile || starting) return;
		starting = true;
		startError = '';

		try {
			const scene = await startConversation({ profile, topic });
			scenario = scene;
			// The opener is already a teacher turn; the loop takes over from there.
			// Its translation is seeded with it: replayed into the next request it is
			// the first example the turn model sees of its own envelope.
			turns = scene.opener
				? [
						{
							role: 'teacher',
							reply: scene.opener,
							...(scene.openerTranslation ? { translation: scene.openerTranslation } : {}),
							actions: []
						}
					]
				: [];
			focusComposer();
		} catch (cause) {
			startError = cause instanceof Error ? cause.message : 'Could not start a conversation.';
		} finally {
			starting = false;
		}
	}

	/**
	 * The one round trip: ask, pin the correction onto the learner's bubble, then
	 * append the teacher's turn. Both callers below do exactly this and differ
	 * only in what history they consider sent.
	 */
	async function ask(history: ConversationTurn[], text: string, who: Profile, scene: Scenario) {
		busy = true;
		pendingError = null;

		try {
			const result = await sendTurn(history, scene, text, who);
			const last = turns[turns.length - 1];
			if (last?.role === 'learner') {
				if (result.correction) last.correction = result.correction;
				if (result.heard) last.heard = result.heard;
			}
			turns = [...turns, result.teacher];
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

<main class="shell">
	{#if loading}
		<div class="loading">
			<Spinner />
		</div>
	{:else if loadError}
		<div class="card">
			<p class="error" role="alert">{loadError}</p>
		</div>
	{:else}
		<header class="topbar ll-rise">
			<a class="back" href="/" aria-label="Back to home">
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

		{#if !scenario}
			<div class="setup">
				<span class="mark" aria-hidden="true">
					<svg class="ico" viewBox="0 0 24 24">
						<path d="M4.6 6.4h9.6v7.2H8.2l-3.6 3v-3H4.6Z" />
						<path d="M10.6 9.4h8.8v6.2h-2.4v2.6l-3-2.6h-3.4Z" />
					</svg>
				</span>
				<p class="setup-lead">
					Pick something to talk about, or leave it blank and I'll choose a scene for us. You'll
					both stay in character — I'll correct your {profile?.targetLanguage} quietly as we go.
				</p>

				<input
					class="topic-input"
					type="text"
					placeholder="Ordering coffee, arguing about football…"
					aria-label="What should we talk about?"
					disabled={starting}
					bind:value={topic}
					onkeydown={(event) => {
						if (event.key === 'Enter') void start();
					}}
				/>

				<div class="examples">
					{#each EXAMPLE_TOPICS as example (example)}
						<button
							type="button"
							class="example-chip"
							disabled={starting}
							onclick={() => (topic = example)}
						>
							{example}
						</button>
					{/each}
				</div>

				<button
					type="button"
					class="btn btn-primary start-btn"
					disabled={starting}
					onclick={() => void start()}
				>
					{starting ? 'Setting the scene…' : 'Start'}
				</button>

				{#if startError}
					<p class="error" role="alert">{startError}</p>
				{/if}
			</div>
		{:else}
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
									<span class="marked">
										{#each correctionSpans(turn.text, turn.correction) as span, spanIndex (spanIndex)}
											<span class="span {span.kind}">{span.text}</span>
										{/each}
									</span>
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

			<form class="composer" onsubmit={(event) => event.preventDefault()}>
				<textarea
					bind:this={textareaEl}
					class="composer-input"
					rows="1"
					placeholder={`Reply in ${profile?.targetLanguage ?? 'the target language'}…`}
					aria-label="Your reply"
					disabled={busy}
					bind:value={input}
					onkeydown={onComposerKeydown}
					oninput={autoGrow}></textarea>
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
	{/if}
</main>

<style>
	.shell {
		max-width: 34rem;
		margin: 0 auto;
		height: 100dvh;
		padding: 1.25rem 1rem 0;
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

	/* The start screen: one question, asked the way the onboarding steps ask. */
	.setup {
		flex: 1 0 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		text-align: center;
		padding: 1.5rem 0.5rem;
	}

	.mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--primary-soft) 65%, transparent);
		color: var(--primary-strong);
	}

	.mark .ico {
		width: 1.5rem;
		height: 1.5rem;
	}

	.setup-lead {
		margin: 0;
		color: var(--text-muted);
		max-width: 26rem;
		text-wrap: balance;
	}

	.topic-input {
		width: 100%;
		max-width: 24rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		box-shadow: inset 0 1px 2px rgb(60 50 20 / 6%);
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.topic-input::placeholder {
		color: var(--text-muted);
		opacity: 0.7;
	}

	.topic-input:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--ring);
	}

	.examples {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.4rem;
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

	.start-btn {
		padding: 0.7rem 2rem;
	}

	/* The scene, written out like the header of a script: what the page is
	   about, before a word of the target language appears. */
	.scene {
		flex: 0 0 auto;
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
