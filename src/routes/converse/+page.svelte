<!--
  The conversation library: every scene the learner has played, and the door to
  one more.

  A spread, and the pairing is the reading library's — the *doing* (set a scene)
  opposite the *state* (what has already been said). On a phone the start screen
  comes first, because an empty shelf is the common case on the day someone
  finds this page.

  Nothing here is ephemeral any more. `startConversation` hands back a scene;
  this page mints the id and the timestamp, stores it, seeds the opener as the
  first exchange and opens `/converse/[id]`, which is the same shape
  `/read` uses and the whole reason `$lib/conversation` can stay stateless.
-->
<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';

	import { startConversation } from '$lib/conversation';
	import {
		addConversation,
		addExchange,
		deleteConversation,
		getConversations,
		getProfile
	} from '$lib/db';
	import type { ConversationSummary } from '$lib/db';
	import { newUuid } from '$lib/device';
	import { isMockMode } from '$lib/llm';
	import type { Conversation, Profile } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	/** Nudges, not choices — the same shape `/read` offers over its topic box. */
	const EXAMPLE_TOPICS = ['Ordering coffee', 'Asking for directions', 'Arguing about football'];

	let loading = $state(true);
	let loadError = $state('');
	let profile = $state<Profile | undefined>(undefined);
	let conversations = $state<ConversationSummary[]>([]);
	let mockMode = $state(false);

	let topic = $state('');
	let starting = $state(false);
	let startError = $state('');

	/**
	 * The forget flow, armed per row: the first tap swaps the quiet button for an
	 * explicit confirm pair. There is no undo, so one mis-tap must never be
	 * enough — and a browser `confirm()` would be the only native dialog in the
	 * app, so the second step lives on the page, exactly as it does in the ledger.
	 */
	let confirming = $state<string | null>(null);
	let removing = $state(false);
	let removeError = $state('');

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

		Promise.all([getProfile(), getConversations()])
			.then(([loadedProfile, loadedConversations]) => {
				if (cancelled) return;
				// `undefined` here means the root layout is about to redirect to
				// onboarding — keep the spinner up rather than flashing an error.
				if (!loadedProfile) return;
				profile = loadedProfile;
				conversations = loadedConversations;
				mockMode = isMockMode();
				loading = false;
			})
			.catch((cause) => {
				if (cancelled) return;
				loadError = cause instanceof Error ? cause.message : 'Could not open your conversations.';
				loading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	/**
	 * The setup call, then the two writes that make the scene a real thing: the
	 * conversation itself, and — when the teacher speaks first — its opener as
	 * exchange zero, the one exchange with no learner half.
	 *
	 * Its failure is its own, so the start screen can offer another go.
	 */
	async function start() {
		if (!profile || starting) return;
		starting = true;
		startError = '';
		const chosen = topic.trim();

		try {
			const scene = await startConversation({ profile, topic });
			const conversation: Conversation = {
				id: newUuid(),
				scenario: scene,
				...(chosen ? { topic: chosen } : {}),
				createdAt: Date.now()
			};
			await addConversation(conversation);

			if (scene.opener) {
				await addExchange({
					conversationId: conversation.id,
					index: 0,
					teacher: {
						role: 'teacher',
						reply: scene.opener,
						...(scene.openerTranslation ? { translation: scene.openerTranslation } : {}),
						actions: []
					}
				});
			}

			await goto(`/converse/${conversation.id}`);
		} catch (cause) {
			startError = cause instanceof Error ? cause.message : 'Could not start a conversation.';
		} finally {
			starting = false;
		}
	}

	async function remove(id: string) {
		if (removing) return;
		removing = true;
		removeError = '';
		try {
			await deleteConversation(id);
			conversations = conversations.filter((row) => row.id !== id);
			confirming = null;
		} catch (cause) {
			removeError = cause instanceof Error ? cause.message : 'Could not delete that conversation.';
		} finally {
			removing = false;
		}
	}
</script>

<svelte:head>
	<title>Sapling · Conversation</title>
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
					<h1>Conversation</h1>
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
						No API key configured — conversations run in offline demo mode, in a fixed Spanish
						scene.
					</span>
				</p>
			{/if}

			<!-- Doing. First in source order, so the phone meets the start screen
			     before a shelf that may well be empty. -->
			<section class="card compose-card ll-rise" style="animation-delay: 120ms">
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

				<label class="field">
					<span class="label">What about?</span>
					<input
						class="input"
						type="text"
						placeholder="Ordering coffee, arguing about football…"
						disabled={starting}
						bind:value={topic}
						onkeydown={(event) => {
							if (event.key === 'Enter') void start();
						}}
					/>
				</label>

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
					class="btn btn-primary btn-block go"
					disabled={starting}
					onclick={() => void start()}
				>
					{starting ? 'Setting the scene…' : startError ? 'Try again' : 'Start'}
				</button>

				{#if startError}
					<p class="error" role="alert">{startError}</p>
				{/if}
			</section>

			<!-- State: the shelf. -->
			<section class="shelf ll-rise" style="animation-delay: 180ms">
				<h2 class="shelf-head">Your conversations</h2>
				{#if conversations.length === 0}
					<p class="hint empty">
						Nothing on the shelf yet — every scene you play stays here, and you can pick one up
						where you left it.
					</p>
				{:else}
					<ul class="chats">
						{#each conversations as chat (chat.id)}
							<li class="chat">
								<a class="chat-row" href="/converse/{chat.id}">
									<span class="chat-title">{chat.scenario.setting}</span>
									<span class="chat-meta">
										{#if chat.topic}
											<span class="badge">{chat.topic}</span>
										{/if}
										<span>{dates.format(chat.lastTurnAt ?? chat.createdAt)}</span>
										<span>{chat.turnCount} turn{chat.turnCount === 1 ? '' : 's'}</span>
									</span>
								</a>

								{#if confirming === chat.id}
									<div class="forget-block">
										<p class="forget-warning">
											It goes for good, here and on every paired device. Words the teacher filed
											stay.
										</p>
										<div class="forget-actions">
											<button
												type="button"
												class="btn forget-confirm"
												disabled={removing}
												onclick={() => void remove(chat.id)}
											>
												Delete for good
											</button>
											<button
												type="button"
												class="btn btn-ghost"
												disabled={removing}
												onclick={() => (confirming = null)}
											>
												Keep it
											</button>
										</div>
									</div>
								{:else}
									<button
										type="button"
										class="btn btn-ghost forget-arm"
										onclick={() => {
											confirming = chat.id;
											removeError = '';
										}}
									>
										<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
											<path d="M5.4 7h13.2" />
											<path d="M9.2 7V5.2h5.6V7" />
											<path d="m7 7 .8 12h8.4L17 7" />
										</svg>
										Delete
									</button>
								{/if}
							</li>
						{/each}
					</ul>

					{#if removeError}
						<p class="error" role="alert">{removeError}</p>
					{/if}
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

	/* A pencilled-in note in the margin, not a banner — same as `/read`. */
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

	/* The start screen ---------------------------------------------------- */

	.compose-card {
		text-align: center;
	}

	.mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 3rem;
		height: 3rem;
		margin-bottom: 0.9rem;
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
		margin: 0 auto 1.2rem;
		color: var(--text-muted);
		max-width: 26rem;
		text-wrap: balance;
	}

	.field {
		text-align: left;
	}

	.field:last-of-type {
		margin-bottom: 0.75rem;
	}

	.examples {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
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
		text-align: left;
	}

	/* The shelf ----------------------------------------------------------- */

	.shelf-head {
		margin: 0 0 0.75rem;
		font-size: 1.05rem;
	}

	/* Not a card: a run of rows reads as a list of things, and a card around it
	   would claim the shelf is one object. */
	.chats {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	/* The row and its danger control are separate children, because a delete
	   button cannot live inside the link that opens the transcript. */
	.chat {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.35rem;
	}

	.chat-row {
		display: block;
		width: 100%;
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

	.chat-row:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
	}

	.chat-row:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* The setting is the scene's name: prose, so it keeps a reading measure even
	   in a wide column. */
	.chat-title {
		display: block;
		font-family: var(--font-display);
		font-size: 1.02rem;
		font-weight: 700;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.chat-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem 0.6rem;
		margin-top: 0.3rem;
		font-size: 0.78rem;
		font-weight: 400;
		color: var(--text-muted);
	}

	/* What the learner asked for, when they asked for anything. */
	.badge {
		padding: 0.1rem 0.45rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.7rem;
		font-weight: 700;
		letter-spacing: 0.04em;
	}

	.forget-block {
		padding: 0 0.25rem 0.35rem;
	}

	.forget-arm {
		padding: 0.35rem 0.7rem;
		font-size: 0.78rem;
	}

	.forget-arm .ico {
		width: 1rem;
		height: 1rem;
	}

	.forget-arm:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		color: var(--danger);
	}

	.forget-warning {
		margin: 0 0 0.6rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--danger);
	}

	.forget-actions {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.forget-actions .btn {
		padding: 0.45rem 0.9rem;
		font-size: 0.83rem;
	}

	/* The danger twin of .btn-primary, pressed edge and all. */
	.forget-confirm {
		background: var(--danger);
		color: var(--text-inverse);
		box-shadow: 0 3px 0 color-mix(in srgb, var(--danger) 70%, black);
	}

	.forget-confirm:hover:not(:disabled) {
		filter: brightness(1.04);
	}

	.forget-confirm:active:not(:disabled) {
		box-shadow: 0 1px 0 color-mix(in srgb, var(--danger) 70%, black);
	}

	.empty {
		margin: 0;
		padding: 1rem 0;
		text-wrap: balance;
	}
</style>
