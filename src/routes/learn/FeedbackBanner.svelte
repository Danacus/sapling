<!--
  The verdict banner: slides up from the bottom the moment an answer is
  committed, and owns everything that happens after grading.

  It is also the only place in a session that can spend tokens after the batch
  was generated. "Explain" is opt-in, one call, and carries just this one
  challenge plus the learner's own question — which is the whole point of
  grading locally first.

  That call can also *win*: when the model agrees a `wrong` answer should have
  counted it replies `overturn: true`, the banner repaints green and
  `onoverturn` lets the page pay the XP and fix the SRS card.
-->
<script lang="ts">
	import { fly, slide } from 'svelte/transition';

	import { getEscalation, LlmError } from '$lib/llm';
	import { motionMs } from '$lib/session/motion';
	import type { Challenge, Verdict } from '$lib/types';
	import Spinner from '$lib/ui/Spinner.svelte';

	let {
		challenge,
		verdict,
		answerGiven,
		correctAnswer,
		closestAccepted,
		explanation,
		xp,
		nativeLanguage,
		targetLanguage,
		skipped = false,
		last = false,
		overturned = false,
		oncontinue,
		onoverturn
	}: {
		challenge: Challenge;
		verdict: Verdict;
		answerGiven: string;
		/** What we tell the learner they should have written. */
		correctAnswer: string;
		/** Nearest accepted form, for the "almost" nudge. */
		closestAccepted?: string;
		explanation?: string;
		xp: number;
		nativeLanguage: string;
		targetLanguage: string;
		/**
		 * The learner pressed "Too hard — skip" rather than answering. Still a
		 * `wrong` verdict everywhere else; it only changes what the banner says,
		 * because "Not quite" is the wrong thing to tell someone who never tried.
		 */
		skipped?: boolean;
		/** Renders "Finish" instead of "Continue" on the last challenge. */
		last?: boolean;
		/**
		 * The session accepted this answer after an escalation overturned the
		 * grade. Owned by the page (it also owes XP, the summary and an SRS
		 * review); the banner just repaints itself green.
		 */
		overturned?: boolean;
		oncontinue: () => void;
		/**
		 * Fired once when the model agrees a `wrong` answer should have counted.
		 * The page decides what that is worth.
		 */
		onoverturn?: () => void;
	} = $props();

	let showExplain = $state(false);
	let question = $state('');
	let asking = $state(false);
	let answer = $state('');
	let askError = $state('');
	let questionInput = $state<HTMLInputElement | null>(null);

	/** What the banner paints as, once a dispute has been won. */
	const shownVerdict = $derived(overturned ? 'correct' : verdict);

	const headline = $derived(
		overturned
			? 'Accepted — your answer counts.'
			: skipped
				? correctAnswer
					? 'Skipped — the answer was:'
					: 'Skipped.'
				: verdict === 'correct'
					? 'Correct!'
					: verdict === 'almost'
						? 'Almost — we counted it.'
						: 'Not quite.'
	);

	const detail = $derived.by(() => {
		if (overturned) return correctAnswer ? `Also fine: ${correctAnswer}` : '';
		if (skipped) return correctAnswer;
		if (verdict === 'almost') {
			const form = closestAccepted || correctAnswer;
			return form ? `Correct form: ${form}` : '';
		}
		if (verdict === 'wrong') return correctAnswer ? `Answer: ${correctAnswer}` : '';
		return '';
	});

	async function ask(): Promise<void> {
		if (asking) return;
		asking = true;
		askError = '';
		answer = '';
		try {
			const result = await getEscalation({
				challenge,
				answerGiven,
				verdict,
				nativeLanguage,
				targetLanguage,
				...(question.trim() ? { userQuestion: question.trim() } : {})
			});
			answer = result.answer;
			// A dispute can only *win* something back: 'almost' already counted, and
			// 'correct' has nothing to fix. Fired once — the page ignores repeats.
			if (result.overturn && verdict === 'wrong' && !overturned) onoverturn?.();
		} catch (cause) {
			askError =
				cause instanceof LlmError
					? cause.message
					: cause instanceof Error
						? cause.message
						: 'Could not fetch an explanation.';
		} finally {
			asking = false;
		}
	}

	function toggleExplain(): void {
		showExplain = !showExplain;
		if (showExplain) {
			// Focus after the slide has laid the field out.
			setTimeout(() => questionInput?.focus(), 60);
		}
	}

	function onFormSubmit(event: SubmitEvent): void {
		event.preventDefault();
		void ask();
	}

	function onkeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.shiftKey || event.metaKey || event.ctrlKey) return;
		// Enter inside the question field asks; Enter anywhere else continues.
		const target = event.target as HTMLElement | null;
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
		event.preventDefault();
		oncontinue();
	}
</script>

<svelte:window {onkeydown} />

<div
	class="banner {shownVerdict}"
	role="status"
	aria-live="polite"
	transition:fly={{ y: 220, duration: motionMs(260) }}
>
	<div class="inner">
		<div class="head">
			<div class="verdict">
				<span class="mark" aria-hidden="true">
					{overturned
						? '✓'
						: skipped
							? '↷'
							: verdict === 'correct'
								? '✓'
								: verdict === 'almost'
									? '≈'
									: '✕'}
				</span>
				<div class="text">
					<p class="headline">{headline}</p>
					{#if detail}<p class="detail">{detail}</p>{/if}
				</div>
			</div>
			{#if xp > 0}
				<span class="xp" aria-label={`${xp} XP earned`}>+{xp} XP</span>
			{/if}
		</div>

		{#if explanation}
			<p class="explanation">{explanation}</p>
		{/if}

		{#if showExplain}
			<div class="explain" transition:slide={{ duration: motionMs(180) }}>
				<form class="ask" onsubmit={onFormSubmit}>
					<input
						bind:this={questionInput}
						bind:value={question}
						class="input"
						type="text"
						placeholder="Why is this the answer?"
						aria-label="Ask about this answer"
						disabled={asking}
					/>
					<button type="submit" class="btn btn-ghost ask-btn" disabled={asking}>Ask</button>
				</form>

				{#if asking}
					<div class="asking"><Spinner /></div>
				{:else if askError}
					<p class="ask-error" role="alert">{askError}</p>
				{:else if answer}
					<p class="answer">{answer}</p>
				{:else if verdict === 'wrong' && !overturned}
					<p class="ask-hint">
						Think you were right? Ask — a justified answer gets your grade fixed.
					</p>
				{:else}
					<p class="ask-hint">Ask anything about this challenge — "why not …?" works fine.</p>
				{/if}
			</div>
		{/if}

		<div class="actions">
			<button type="button" class="btn btn-ghost explain-btn" onclick={toggleExplain}>
				{showExplain ? 'Hide' : 'Explain'}
			</button>
			<button type="button" class="btn continue" onclick={oncontinue}>
				{last ? 'Finish' : 'Continue'}
			</button>
		</div>
	</div>
</div>

<style>
	.banner {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 20;
		border-top: 2px solid var(--tone);
		background: var(--tone-soft);
		box-shadow: 0 -12px 34px rgb(16 24 40 / 12%);
		padding-bottom: env(safe-area-inset-bottom, 0);
	}

	.banner.correct {
		--tone: var(--primary);
		--tone-strong: var(--primary-strong);
		--tone-soft: color-mix(in srgb, var(--primary) 14%, var(--surface));
	}

	.banner.almost {
		--tone: var(--amber);
		--tone-strong: var(--amber);
		--tone-soft: color-mix(in srgb, var(--amber) 16%, var(--surface));
	}

	.banner.wrong {
		--tone: var(--danger);
		--tone-strong: var(--danger);
		--tone-soft: color-mix(in srgb, var(--danger) 14%, var(--surface));
	}

	.inner {
		max-width: 34rem;
		margin: 0 auto;
		padding: 1rem 1rem 1.25rem;
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.verdict {
		display: flex;
		align-items: flex-start;
		gap: 0.7rem;
		min-width: 0;
	}

	.mark {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		background: var(--tone);
		color: var(--text-inverse);
		font-size: 1.05rem;
		font-weight: 900;
		line-height: 1;
	}

	.text {
		min-width: 0;
	}

	.headline {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 900;
		color: var(--tone-strong);
		line-height: 1.25;
	}

	.detail {
		margin: 0.15rem 0 0;
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.xp {
		flex: 0 0 auto;
		padding: 0.25rem 0.6rem;
		border-radius: 999px;
		background: var(--tone);
		color: var(--text-inverse);
		font-size: 0.8rem;
		font-weight: 900;
		letter-spacing: 0.02em;
	}

	.explanation {
		margin: 0.7rem 0 0;
		padding-left: 2.7rem;
		font-size: 0.92rem;
		line-height: 1.45;
		color: var(--text);
		opacity: 0.85;
	}

	.explain {
		margin-top: 0.85rem;
		padding: 0.8rem;
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--surface) 70%, transparent);
	}

	.ask {
		display: flex;
		gap: 0.5rem;
	}

	.ask-btn {
		flex: 0 0 auto;
	}

	.asking {
		padding: 0.8rem 0;
	}

	.answer,
	.ask-hint,
	.ask-error {
		margin: 0.7rem 0 0;
		font-size: 0.92rem;
		line-height: 1.5;
	}

	.ask-hint {
		color: var(--text-muted);
	}

	.ask-error {
		color: var(--danger);
		font-weight: 700;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin-top: 1rem;
	}

	.explain-btn {
		padding: 0.85rem 1rem;
	}

	.continue {
		flex: 1;
		background: var(--tone);
		color: var(--text-inverse);
		box-shadow: 0 4px 0 color-mix(in srgb, var(--tone) 70%, black);
	}

	.continue:active:not(:disabled) {
		box-shadow: 0 2px 0 color-mix(in srgb, var(--tone) 70%, black);
	}

	@media (max-width: 480px) {
		.explanation {
			padding-left: 0;
		}
	}
</style>
