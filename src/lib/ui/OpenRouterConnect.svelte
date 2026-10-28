<!--
  "Connect OpenRouter": a key by PKCE sign-in, beside the key field rather than
  instead of it. A browser opens a popup whose callback page answers over a
  BroadcastChannel; a Tauri host (whose origin no callback can reach) and a
  blocked popup take the headless flow, where OpenRouter shows a code to paste.
  The caller stores the key.
-->
<script lang="ts">
	import {
		authUrl,
		CALLBACK_CHANNEL,
		CALLBACK_PATH,
		challengeFor,
		exchangeCode,
		exchangeMessage,
		randomToken
	} from '$lib/llm/openrouter-auth';
	import { inTauri } from '$lib/platform';
	import InlineStatus from '$lib/ui/InlineStatus.svelte';

	let { onkey }: { onkey: (key: string) => void } = $props();

	let phase = $state<'idle' | 'waiting' | 'paste' | 'exchanging'>('idle');
	let headlessUrl = $state('');
	let pastedCode = $state('');
	let error = $state('');

	let verifier = '';
	let expectedState = '';
	let channel: BroadcastChannel | undefined;

	function closeChannel() {
		channel?.close();
		channel = undefined;
	}

	$effect(() => closeChannel);

	async function connect() {
		error = '';
		headlessUrl = '';
		closeChannel();
		verifier = randomToken();
		// Opened before the first await, or the click no longer counts as the
		// gesture a popup needs.
		const popup =
			!inTauri() && typeof BroadcastChannel !== 'undefined'
				? window.open('', 'sapling-openrouter', 'popup,width=520,height=720')
				: null;
		const challenge = await challengeFor(verifier);
		if (!popup) {
			headlessUrl = authUrl(challenge);
			pastedCode = '';
			phase = 'paste';
			return;
		}
		expectedState = randomToken();
		channel = new BroadcastChannel(CALLBACK_CHANNEL);
		channel.onmessage = (event: MessageEvent<{ code?: unknown; state?: unknown }>) => {
			const { code, state } = event.data ?? {};
			if (typeof code !== 'string' || state !== expectedState) return;
			closeChannel();
			void exchange(code);
		};
		popup.location.href = authUrl(challenge, `${location.origin}${CALLBACK_PATH}`, expectedState);
		phase = 'waiting';
	}

	async function exchange(code: string) {
		if (!code.trim()) return;
		const from = phase;
		phase = 'exchanging';
		const result = await exchangeCode(code, verifier);
		if (result.ok) {
			phase = 'idle';
			pastedCode = '';
			onkey(result.key);
			return;
		}
		error = exchangeMessage(result.reason);
		// A pasted code can be retried by fetching a fresh one from the same link.
		phase = from === 'paste' ? 'paste' : 'idle';
	}
</script>

<div class="connect">
	<div class="row">
		<button
			type="button"
			class="btn"
			onclick={() => void connect()}
			disabled={phase === 'exchanging'}
		>
			{#if phase === 'waiting'}
				Waiting for OpenRouter…
			{:else if phase === 'exchanging'}
				Connecting…
			{:else}
				Connect OpenRouter
			{/if}
		</button>
		<InlineStatus status={error ? 'error' : 'idle'} message={error} />
	</div>

	{#if phase === 'waiting'}
		<p class="hint">Sign in in the window that opened. Pressing the button again starts over.</p>
	{:else if phase === 'paste' || (phase === 'exchanging' && headlessUrl)}
		<p class="hint">
			<a href={headlessUrl} target="_blank" rel="noreferrer noopener">Sign in at OpenRouter</a>,
			then paste the code it shows.
		</p>
		<div class="row">
			<input
				class="input"
				bind:value={pastedCode}
				placeholder="Paste the code"
				aria-label="OpenRouter code"
				autocomplete="off"
				spellcheck="false"
				disabled={phase === 'exchanging'}
			/>
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void exchange(pastedCode)}
				disabled={phase === 'exchanging' || !pastedCode.trim()}
			>
				Use code
			</button>
		</div>
	{/if}
</div>

<style>
	.connect {
		display: grid;
		gap: 0.6rem;
		margin-bottom: 1rem;
	}

	.row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.6rem;
	}

	.row .input {
		flex: 1 1 12rem;
		min-width: 0;
	}

	.hint {
		margin: 0;
	}
</style>
