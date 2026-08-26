<!--
  The assistant chat screen: a conversation with an LLM that manages the
  learner's word list via tool calls. Ephemeral on purpose — no history is
  persisted, so a reload always starts a fresh conversation. `sendChatMessage`
  is stateless like the rest of `$lib/llm`; this component owns the turn list
  and passes it back in on every call.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { tick } from 'svelte';

	import type { ActionNote, AssistantTurn, ChatTurn } from '$lib/assistant';
	import { sendChatMessage } from '$lib/assistant';
	import { getProfile } from '$lib/db';
	import { isMockMode } from '$lib/llm';
	import type { Profile } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	const EXAMPLE_PROMPTS = [
		'Add the word "hola" meaning "hello" to my list',
		'Which words do I know?',
		'Clean up duplicates in my vocabulary'
	];

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let mockMode = $state(false);

	let turns = $state<ChatTurn[]>([]);
	let input = $state('');
	let busy = $state(false);
	/** Set only when the last send failed — the failed user turn stays in `turns`. */
	let pendingError = $state<{ text: string; message: string } | null>(null);

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

	// Sticks the message list to the bottom on every new turn or state change
	// that adds a row (typing indicator, error bubble) — never on the initial
	// empty state, so the intro card doesn't jump.
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

	function useExample(prompt: string) {
		input = prompt;
		textareaEl?.focus();
		void tick().then(autoGrow);
	}

	function focusComposer() {
		void tick().then(() => textareaEl?.focus());
	}

	/**
	 * The one round trip: ask, append the reply, and leave `pendingError` holding
	 * everything {@link retry} needs to have another go. Both callers below do
	 * exactly this and differ only in what history they consider sent.
	 */
	async function ask(history: ChatTurn[], text: string, who: Profile) {
		busy = true;
		pendingError = null;

		try {
			const reply = await sendChatMessage(history, text, who);
			turns = [...turns, reply];
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
		if (!text || busy || !profile) return;

		const history = [...turns];
		turns = [...turns, { role: 'user', text }];
		input = '';
		void tick().then(autoGrow);

		await ask(history, text, profile);
	}

	/** Re-sends the last failed turn with the same history it originally used. */
	async function retry() {
		if (!pendingError || busy || !profile) return;
		// The failed user turn is the last one in `turns` — everything before it
		// is the history the first attempt sent too.
		await ask(turns.slice(0, -1), pendingError.text, profile);
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	}

	function actionChipClass(action: ActionNote): string {
		return action.ok ? 'chip ok' : 'chip fail';
	}
</script>

<svelte:head>
	<title>Sapling · Assistant</title>
</svelte:head>

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
				<h1>Assistant</h1>
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
					No API key configured — the assistant is running in offline demo mode. Try: hola = hello
				</span>
			</p>
		{/if}

		<div class="messages" bind:this={messagesEl} aria-live="polite">
			{#if turns.length === 0}
				<div class="empty">
					<span class="mark" aria-hidden="true">
						<svg class="ico" viewBox="0 0 24 24">
							<path
								d="M20.3 12.2c0 4-3.7 7.2-8.2 7.2a9.4 9.4 0 0 1-2.5-.3L4.6 20.5l1.3-3.7a6.9 6.9 0 0 1-2.2-4.6C3.7 8.2 7.4 5 11.9 5s8.4 3.2 8.4 7.2Z"
							/>
							<path d="M9 11.9h.01M12 11.9h.01M15 11.9h.01" />
						</svg>
					</span>
					<p class="empty-lead">
						Ask me to add words to your list, look words up, or clean up your vocabulary.
					</p>
					<div class="examples">
						{#each EXAMPLE_PROMPTS as prompt (prompt)}
							<button type="button" class="example-chip" onclick={() => useExample(prompt)}>
								<span>{prompt}</span>
								<svg class="ico jump-ico" viewBox="0 0 24 24" aria-hidden="true">
									<path d="M4.8 12h14" />
									<path d="m13.4 6.6 5.4 5.4-5.4 5.4" />
								</svg>
							</button>
						{/each}
					</div>
				</div>
			{/if}

			{#each turns as turn, index (index)}
				{#if turn.role === 'user'}
					<div class="row user-row">
						<div class="bubble user-bubble">{turn.text}</div>
					</div>
				{:else}
					<div class="row assistant-row">
						<div class="bubble assistant-bubble">
							{turn.text}
							{#if turn.actions.length > 0}
								<div class="actions">
									{#each turn.actions as action, actionIndex (actionIndex)}
										<span class={actionChipClass(action)}>
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
				<div class="row assistant-row">
					<div class="bubble assistant-bubble typing" role="status" aria-label="Assistant is typing">
						<span class="dot"></span>
						<span class="dot"></span>
						<span class="dot"></span>
					</div>
				</div>
			{/if}

			{#if pendingError}
				<div class="row assistant-row">
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
				placeholder="Message the assistant…"
				aria-label="Message the assistant"
				disabled={busy}
				bind:value={input}
				onkeydown={onComposerKeydown}
				oninput={autoGrow}
			></textarea>
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

	/* One hand for every icon on this screen, matching the dashboard: 24-unit
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

	/* The same squircle the dashboard's topbar controls wear. */
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

	/*
	  The transcript runs down the page against a notebook's margin rule — the
	  app's one stitched hairline, turned on its side. Everything written in
	  this session sits to the right of it.
	*/
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

	.empty {
		flex: 1 0 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		text-align: center;
		padding: 1.5rem 0.5rem;
	}

	/* The same pressed-specimen frame the onboarding steps open with. */
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

	.empty-lead {
		margin: 0;
		color: var(--text-muted);
		max-width: 26rem;
		text-wrap: balance;
	}

	.examples {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
		max-width: 24rem;
	}

	/* Openers, listed like entries: hairline frame, the prompt on the left and
	   an arrow that leans in when you hover it. */
	.example-chip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		padding: 0.6rem 0.8rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 500;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.example-chip:hover {
		border-color: var(--text-muted);
		background: var(--surface-alt);
	}

	.example-chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.jump-ico {
		width: 0.95rem;
		height: 0.95rem;
		color: var(--text-muted);
		transition: transform 0.15s ease;
	}

	.example-chip:hover .jump-ico {
		color: var(--primary-strong);
		transform: translateX(2px);
	}

	.row {
		display: flex;
		animation: ll-rise 0.28s cubic-bezier(0.2, 0.7, 0.3, 1) both;
	}

	.user-row {
		justify-content: flex-end;
	}

	.assistant-row {
		justify-content: flex-start;
	}

	/*
	  Both sides are paper. The learner's turns are the terracotta-tinted slips
	  pasted in on the right; the assistant answers on the plain sheet — no
	  saturated fill anywhere, so a long thread still reads like a page.
	*/
	.bubble {
		max-width: 84%;
		padding: 0.7rem 0.9rem;
		border-radius: var(--radius);
		font-size: 0.95rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}

	.user-bubble {
		border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
		background: color-mix(in srgb, var(--accent) 14%, var(--surface));
		color: var(--text);
		border-bottom-right-radius: 4px;
	}

	.assistant-bubble {
		background: var(--surface);
		border: 1px solid var(--border);
		border-bottom-left-radius: 4px;
		box-shadow: 0 1px 0 color-mix(in srgb, var(--border) 70%, transparent);
	}

	/* What the assistant actually did, receipted under a stitched rule — the
	   reply is prose, the tool calls are the ledger entry beneath it. */
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

	/* Ruled off from the transcript, the way a form is ruled off from the page
	   it belongs to. */
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

		.jump-ico {
			transition: none;
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
