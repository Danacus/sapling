<!--
  The verdict banner: slides up from the bottom the moment an answer is
  committed, and owns everything that happens after grading.

  It is also the only place in a session that can spend tokens after the batch
  was generated. "Explain" is opt-in, one call, and carries just this one
  challenge plus the learner's own question — which is the whole point of
  grading locally first.

  That call can also *win*: when the model agrees a `wrong` answer should have
  counted it replies `overturn: true`, the banner repaints green and
  `onoverturn` lets the page fix the SRS card.
-->
<script lang="ts">
	import { fly, slide } from 'svelte/transition';

	import { answerReading, spokenAnswerFor } from '$lib/challenges/display';
	import { getEscalation, LlmError } from '$lib/llm';
	import { motionMs } from '$lib/session/motion';
	import { Grade } from '$lib/srs';
	import { speak } from '$lib/tts';
	import type { Challenge, Verdict } from '$lib/types';
	import { getRomanizationMode } from '$lib/ui/prefs';
	import SpeakButton from '$lib/ui/SpeakButton.svelte';
	import Spinner from '$lib/ui/Spinner.svelte';

	let {
		challenge,
		verdict,
		answerGiven,
		correctAnswer,
		closestAccepted,
		explanation,
		nativeLanguage,
		targetLanguage,
		skipped = false,
		last = false,
		overturned = false,
		oncontinue,
		onoverturn,
		onassess,
		onreport
	}: {
		challenge: Challenge;
		verdict: Verdict;
		answerGiven: string;
		/** What we tell the learner they should have written. */
		correctAnswer: string;
		/** Nearest accepted form, for the "almost" nudge. */
		closestAccepted?: string;
		explanation?: string;
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
		 * grade. Owned by the page (it also owes the summary and an SRS review);
		 * the banner just repaints itself green.
		 */
		overturned?: boolean;
		oncontinue: () => void;
		/**
		 * Fired once when the model agrees a `wrong` answer should have counted.
		 * The page decides what that is worth.
		 */
		onoverturn?: () => void;
		/**
		 * The learner re-rated a correct answer. Fires on every change away from
		 * the current selection, including back to `Good`; the page re-grades the
		 * review from its pre-answer state, so the last call wins.
		 */
		onassess?: (grade: Grade) => void;
		/**
		 * The learner flagged this challenge as broken. Fired at most once; the
		 * page excludes it from the pool for good. Absent for locally built
		 * match-pairs rounds, which have no pool row to flag.
		 */
		onreport?: () => void;
	} = $props();

	// Adaptive mode never hides the reading here: hiding is a during-recall aid,
	// and the post-answer reveal is the teaching moment.
	/** Read once — the setting lives in Settings, not mid-session. */
	const showRomanization = getRomanizationMode() !== 'off';

	let showExplain = $state(false);
	let question = $state('');
	let asking = $state(false);
	let answer = $state('');
	let askError = $state('');
	let questionInput = $state<HTMLInputElement | null>(null);

	/* Self-assessment ------------------------------------------------------- */

	const ASSESS_CHOICES = [
		{ grade: Grade.Hard, label: 'Hard' },
		{ grade: Grade.Good, label: 'Good' },
		{ grade: Grade.Easy, label: 'Easy' }
	] as const;

	/**
	 * Only a clean `correct` is worth asking about. `almost` already means "you
	 * fumbled it" (auto-Hard) and `wrong` means Again; a skip never tried; an
	 * overturned answer was argued back, not recalled; and match rounds touch no
	 * card at all.
	 */
	const canAssess = $derived(
		verdict === 'correct' && !skipped && !overturned && challenge.type !== 'match-pairs'
	);

	/**
	 * Preselected Good, which is exactly what the answer already scored — so a
	 * learner who ignores this row gets the neutral default and no extra write.
	 */
	let assessed = $state<Grade>(Grade.Good);

	function assess(grade: Grade): void {
		if (grade === assessed) return;
		assessed = grade;
		onassess?.(grade);
	}

	/* Reporting -------------------------------------------------------------- */

	/**
	 * Flagged, and staying flagged for as long as this banner is up — the button
	 * turns into its own receipt rather than a toast, because the learner is
	 * about to leave the banner anyway.
	 *
	 * Deliberately does *not* advance the session: a challenge worth reporting is
	 * usually one the learner still wants explained.
	 */
	let reported = $state(false);

	function report(): void {
		if (reported) return;
		reported = true;
		onreport?.();
	}

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

	/**
	 * What the speak button says — always the canonical target-script form
	 * (`spokenAnswerFor`), never the variant {@link detail} is showing.
	 *
	 * The two deliberately diverge: `closestAccepted` is whichever accepted
	 * variant the learner came nearest to, routinely a (possibly tone-stripped)
	 * romanization for a non-Latin target. Printing it back is right — it is the
	 * form they nearly wrote; handing it to a Mandarin voice is not, because the
	 * synthesizer reads Latin letters as Latin letters.
	 *
	 * Shared with the session screen, which pre-synthesizes this exact string
	 * when the challenge is shown — that is what makes the auto-play below land
	 * instantly instead of a second or two after the grade.
	 */
	const spokenAnswer = $derived(spokenAnswerFor(challenge));

	/**
	 * Auto-play the answer once, the moment the banner appears.
	 *
	 * One rule for every challenge type: if there is target-language audio worth
	 * hearing ({@link spokenAnswer} non-empty), it plays on answering — the same
	 * moment the grade lands, when the learner's attention is already on the
	 * answer. Living here rather than in the components is what makes it
	 * consistent; a per-component call is how cloze ended up speaking while
	 * multiple choice stayed silent. The banner mounts fresh for each answer, so
	 * the flag resets itself, and an overturn repaint never replays. "Hear it"
	 * stays as the manual replay.
	 */
	let autoSpoken = false;
	$effect(() => {
		if (autoSpoken || !spokenAnswer) return;
		autoSpoken = true;
		void speak(spokenAnswer, targetLanguage);
	});

	/**
	 * The Latin reading of the answer the banner is showing — the moment a
	 * learner is told a word they could not produce is exactly when they need to
	 * know how to say it. Absent for Latin scripts, for native-language answers,
	 * and for anything queued before the field existed; each of those simply
	 * renders no line.
	 *
	 * Which field that is per challenge type is `$lib/challenges/display`'s
	 * business; the learner's romanization preference is this component's.
	 */
	const reading = $derived(showRomanization ? (answerReading(challenge) ?? '') : '');

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
				<!-- The verdict, drawn rather than typed: ✓ ↷ ≈ ✕ each rendered at a
				     different weight (and sometimes not at all) in the fallback fonts
				     a target language can land on. Same order as the words above. -->
				<span class="mark" aria-hidden="true">
					{#if overturned}
						<svg class="ico" viewBox="0 0 24 24"><path d="m5 12.8 4.4 4.4L19 7.6" /></svg>
					{:else if skipped}
						<svg class="ico" viewBox="0 0 24 24">
							<path d="M4.6 17.4c0-4.9 3.3-8.4 8.3-8.4H19" />
							<path d="m15.4 5.4 3.6 3.6-3.6 3.6" />
						</svg>
					{:else if verdict === 'correct'}
						<svg class="ico" viewBox="0 0 24 24"><path d="m5 12.8 4.4 4.4L19 7.6" /></svg>
					{:else if verdict === 'almost'}
						<svg class="ico" viewBox="0 0 24 24">
							<path d="M4.6 9.6c2.3-2.3 4.6-2.3 6.9 0s4.6 2.3 6.9 0" />
							<path d="M4.6 15.2c2.3-2.3 4.6-2.3 6.9 0s4.6 2.3 6.9 0" />
						</svg>
					{:else}
						<svg class="ico" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" /></svg>
					{/if}
				</span>
				<div class="text">
					<p class="headline">{headline}</p>
					{#if detail}
						<p class="detail">{detail}</p>
						{#if reading}<p class="rom">{reading}</p>{/if}
					{/if}
					{#if spokenAnswer}
						<SpeakButton text={spokenAnswer} lang={targetLanguage} label="Hear it" size="sm" />
					{/if}
				</div>
			</div>
		</div>

		{#if explanation}
			<p class="explanation">{explanation}</p>
		{/if}

		{#if canAssess}
			<div class="assess" role="group" aria-label="How easy was it?">
				<span class="assess-label">How easy was it?</span>
				<div class="assess-choices">
					{#each ASSESS_CHOICES as choice (choice.grade)}
						<button
							type="button"
							class="assess-btn"
							class:selected={assessed === choice.grade}
							aria-pressed={assessed === choice.grade}
							onclick={() => assess(choice.grade)}
						>
							{choice.label}
						</button>
					{/each}
				</div>
			</div>
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

		<hr class="stitch" />

		<div class="actions">
			<button type="button" class="btn btn-ghost explain-btn" onclick={toggleExplain}>
				{showExplain ? 'Hide' : 'Explain'}
			</button>
			{#if onreport && challenge.type !== 'match-pairs'}
				<button
					type="button"
					class="btn btn-ghost report-btn"
					class:reported
					disabled={reported}
					onclick={report}
					title="This challenge is broken — never show it again"
				>
					{reported ? 'Reported' : 'Report'}
				</button>
			{/if}
			<button type="button" class="btn continue" onclick={oncontinue}>
				{last ? 'Finish' : 'Continue'}
			</button>
		</div>
	</div>
</div>

<style>
	/*
	  A slip of tinted paper slid under the page. Every colour on it is derived
	  from one `--tone`, so the three verdicts are the same object in three inks
	  rather than three designs.

	  `--scrim` is the trick that makes the shadow warm in both palettes: the
	  ink colour is dark in light mode and the *inverse* ink is dark in dark
	  mode, so pointing at the right one gives a token-only "dark" to mix with.
	*/
	.banner {
		--scrim: var(--text);
		position: fixed;
		inset: auto 0 0 0;
		z-index: 20;
		border-top: 2px solid var(--tone);
		background:
			linear-gradient(var(--tone-soft), color-mix(in srgb, var(--tone-soft) 55%, var(--surface))),
			var(--surface);
		box-shadow: 0 -14px 36px color-mix(in srgb, var(--scrim) 16%, transparent);
		padding-bottom: env(safe-area-inset-bottom, 0);
	}

	@media (prefers-color-scheme: dark) {
		.banner {
			--scrim: var(--text-inverse);
		}
	}

	/* Leaf green: the answer stands. */
	.banner.correct {
		--tone: var(--primary);
		--tone-strong: var(--primary-strong);
		--tone-soft: color-mix(in srgb, var(--primary) 15%, var(--surface));
	}

	/*
	  Amber, and the only tone whose ink is not simply the token: raw amber is
	  too pale to read on its own tint in light mode, so the strong variant is
	  pulled towards the page's ink — which lands darker on paper and lighter on
	  moss, exactly as it needs to.
	*/
	.banner.almost {
		--tone: var(--amber);
		--tone-strong: color-mix(in srgb, var(--amber) 55%, var(--text));
		--tone-soft: color-mix(in srgb, var(--amber) 16%, var(--surface));
	}

	/* Warm danger — terracotta gone hot, never a fire-engine red. */
	.banner.wrong {
		--tone: var(--danger);
		--tone-strong: var(--danger);
		--tone-soft: color-mix(in srgb, var(--danger) 14%, var(--surface));
	}

	/* One hand for every icon here, matching the rest of the app. */
	.ico {
		width: 1.15rem;
		height: 1.15rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.9;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/*
	  Same measure as the session shell (`--measure` in app.css), centred the
	  same way, so the banner's card lines up with the challenge column above
	  it rather than with the viewport, at every width.
	*/
	.inner {
		max-width: var(--measure);
		margin: 0 auto;
		/* The side padding has to be the shell's own gutter, not a literal: the
		   cap is on the border box, so a 2rem gutter narrows the column above by
		   2rem and a 1rem padding here would leave the banner wider than it. */
		padding: 1rem var(--gutter) 1.25rem;
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

	/* A pressed stamp, not a badge: hairline frame, tinted paper, tone ink —
	   the same specimen-label idiom the onboarding steps wear. */
	.mark {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 2.1rem;
		height: 2.1rem;
		border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
		border-radius: var(--radius);
		background: color-mix(in srgb, var(--tone) 22%, var(--surface));
		color: var(--tone-strong);
		line-height: 1;
	}

	.text {
		min-width: 0;
	}

	/* The verdict is the headline of the page, so it takes the display face. */
	.headline {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		color: var(--tone-strong);
		line-height: 1.25;
	}

	/* The answer being revealed is target-language text as often as not, so it
	   reads in the same face the prompt did — the teaching moment set as
	   carefully as the question was. */
	.detail {
		margin: 0.2rem 0 0;
		font-family: var(--font-display);
		font-size: 1.05rem;
		font-weight: 700;
		font-variation-settings: 'SOFT' 26;
		overflow-wrap: anywhere;
	}

	.text :global(.speak) {
		margin: 0.2rem 0 0 -0.55rem;
		color: var(--tone-strong);
	}

	.explanation {
		margin: 0.7rem 0 0;
		padding-left: 2.8rem;
		font-size: 0.92rem;
		line-height: 1.5;
		color: var(--text);
		opacity: 0.85;
	}

	/* Self-assessment ------------------------------------------------------- */

	.assess {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem 0.6rem;
		margin-top: 0.85rem;
	}

	.assess-label {
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	.assess-choices {
		display: flex;
		gap: 0.3rem;
	}

	/* True chips, in the app's settled chip voice: hairline, pill, Karla 500,
	   and the picked one filled with a tint of the verdict's own tone. */
	.assess-btn {
		padding: 0.3rem 0.75rem;
		border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent);
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.assess-btn:hover {
		border-color: var(--tone);
		background: color-mix(in srgb, var(--tone) 10%, transparent);
		color: var(--text);
	}

	.assess-btn:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.assess-btn.selected {
		border-color: var(--tone);
		background: color-mix(in srgb, var(--tone) 24%, var(--surface));
		color: var(--tone-strong);
		font-weight: 700;
	}

	.explain {
		margin-top: 0.85rem;
		padding: 0.8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--surface) 80%, transparent);
	}

	.ask {
		display: flex;
		gap: 0.5rem;
	}

	.ask-btn {
		flex: 0 0 auto;
	}

	/* Match the spinner to the slip of paper it sits on: `--spinner-tone`
	   inherits down into `Spinner.svelte`'s scoped rule, so the "Explain"
	   wait reads as one object in the verdict's own ink rather than the
	   component's green default. */
	.asking {
		--spinner-tone: var(--tone-strong);
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

	/* The stitched hairline the whole app uses between a heading and what
	   follows it — here between the verdict and what to do about it. */
	.stitch {
		margin: 0.9rem 0 0.85rem;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.explain-btn {
		padding: 0.85rem 1rem;
	}

	/* Quieter than Explain: a rare escape hatch, not part of the loop. */
	.report-btn {
		padding: 0.85rem 0.7rem;
		font-size: 0.82rem;
		opacity: 0.7;
	}

	.report-btn:hover:not(:disabled) {
		opacity: 1;
	}

	.report-btn.reported {
		opacity: 0.9;
		color: var(--text-muted);
	}

	/*
	  The only filled button on the slip, and it wears the verdict's *strong*
	  ink rather than the raw tone — that is what keeps the label readable on
	  amber, in both palettes. The press is the app's 3D collapse, deepened
	  through `--scrim` so the shadow darkens on paper and on moss alike.
	*/
	.continue {
		flex: 1;
		background: var(--tone-strong);
		color: var(--text-inverse);
		box-shadow: 0 3px 0 color-mix(in srgb, var(--tone-strong) 68%, var(--scrim));
	}

	.continue:hover:not(:disabled) {
		filter: brightness(1.04);
	}

	.continue:active:not(:disabled) {
		box-shadow: 0 1px 0 color-mix(in srgb, var(--tone-strong) 68%, var(--scrim));
	}

	@media (max-width: 480px) {
		.explanation {
			padding-left: 0;
		}
	}
</style>
