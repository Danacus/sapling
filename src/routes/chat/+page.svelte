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

	async function send() {
		const text = input.trim();
		if (!text || busy || !profile) return;

		const history = [...turns];
		turns = [...turns, { role: 'user', text }];
		input = '';
		void tick().then(autoGrow);
		busy = true;
		pendingError = null;

		try {
			const reply = await sendChatMessage(history, text, profile);
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

	/** Re-sends the last failed turn with the same history it originally used. */
	async function retry() {
		if (!pendingError || busy || !profile) return;
		const { text } = pendingError;
		// The failed user turn is the last one in `turns` — everything before it
		// is the history the first attempt sent too.
		const history = turns.slice(0, -1);
		pendingError = null;
		busy = true;

		try {
			const reply = await sendChatMessage(history, text, profile);
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
		<header class="topbar">
			<a class="back" href="/">← Back</a>
			<h1>Assistant</h1>
		</header>

		{#if mockMode}
			<p class="mock-hint">
				No API key configured — the assistant is running in offline demo mode. Try: hola = hello
			</p>
		{/if}

		<div class="messages" bind:this={messagesEl} aria-live="polite">
			{#if turns.length === 0}
				<div class="empty">
					<p class="empty-lead">
						Ask me to add words to your list, look words up, or clean up your vocabulary.
					</p>
					<div class="examples">
						{#each EXAMPLE_PROMPTS as prompt (prompt)}
							<button type="button" class="example-chip" onclick={() => useExample(prompt)}>
								{prompt}
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
											{action.ok ? '✓' : '✕'}
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

	.topbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex: 0 0 auto;
	}

	.back {
		color: var(--text-muted);
		text-decoration: none;
		font-weight: 800;
	}

	.topbar h1 {
		margin: 0;
		font-size: 1.4rem;
	}

	.mock-hint {
		flex: 0 0 auto;
		margin: 0;
		padding: 0.6rem 0.85rem;
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		color: var(--text);
		font-size: 0.8rem;
		font-weight: 600;
	}

	.messages {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.25rem 0.1rem;
	}

	.empty {
		flex: 1 0 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		text-align: center;
		padding: 1.5rem 1rem;
	}

	.empty-lead {
		margin: 0;
		color: var(--text-muted);
		font-weight: 600;
		max-width: 26rem;
	}

	.examples {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
		max-width: 24rem;
	}

	.example-chip {
		padding: 0.65rem 1rem;
		border: 2px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-size: 0.88rem;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.example-chip:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.example-chip:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.row {
		display: flex;
	}

	.user-row {
		justify-content: flex-end;
	}

	.assistant-row {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 82%;
		padding: 0.65rem 0.9rem;
		border-radius: var(--radius);
		white-space: pre-wrap;
		overflow-wrap: break-word;
	}

	.user-bubble {
		background: var(--accent);
		color: var(--text-inverse);
		border-bottom-right-radius: 4px;
	}

	.assistant-bubble {
		background: var(--surface);
		border: 1px solid var(--border);
		border-bottom-left-radius: 4px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-top: 0.55rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		font-size: 0.78rem;
		font-weight: 700;
	}

	.chip.ok {
		background: var(--primary-soft);
		color: var(--text);
	}

	.chip.fail {
		background: color-mix(in srgb, var(--danger) 15%, transparent);
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
		background: color-mix(in srgb, var(--danger) 10%, var(--surface));
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
		padding: 0.4rem 0.9rem;
		font-size: 0.8rem;
	}

	.composer {
		flex: 0 0 auto;
		display: flex;
		align-items: flex-end;
		gap: 0.6rem;
		padding: 0.75rem 0 calc(0.75rem + env(safe-area-inset-bottom));
	}

	.composer-input {
		flex: 1 1 auto;
		min-width: 0;
		max-height: 8rem;
		padding: 0.7rem 0.9rem;
		border: 2px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		line-height: 1.35;
		resize: none;
		transition: border-color 0.15s ease;
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
		padding: 0.6rem 0.8rem;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--danger) 15%, transparent);
		color: var(--danger);
		font-weight: 700;
	}

	@media (max-width: 480px) {
		.shell {
			padding: 1rem 0.75rem 0;
		}
	}
</style>
