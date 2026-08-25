<!--
  Match pairs: the free round.

  These challenges are built locally by `makeMatchPairsChallenge` out of words
  the learner already knows — zero tokens, zero network. They exist to break up
  the rhythm of a session and to give the combo somewhere to breathe.

  Interaction: pick one tile from each column. A correct pair locks in with a
  pop; a wrong pair shakes and both tiles deselect. Mistakes are counted, and a
  round finished with at least one mistake reports 'almost' instead of
  'correct' — that only affects XP, never SRS (see `applyResult`).

  Matching is by *text*, not by which pair object a tile happened to come
  from: two tiles count as a match whenever their texts form any valid pair in
  `challenge.pairs` (case/whitespace-insensitive), not only the one they were
  built from. The generator now guarantees no duplicate labels on either side,
  but this makes identical labels interchangeable if one ever slips through
  rather than making some correct-looking pair unmatchable.

  The tiles are ordinary `TapOption`s: `correct` is a locked-in pair, `wrong`
  the shake, `pop` the one-shot beat over a fresh match. This type does not
  lock the way the others do — the round ends when every pair is matched, not
  when a button is pressed — so it uses the shared lock only for its clock and
  its per-challenge reset.
-->
<script lang="ts">
	import { ALL_READINGS, rubyFor, type ChallengeProps } from '$lib/challenges/props';
	import { speak } from '$lib/tts';
	import type { MatchPairsChallenge } from '$lib/types';
	import { createAnswerLock } from './blocks/answer-lock.svelte.js';
	import PromptHeader from './blocks/PromptHeader.svelte';
	import TapOption from './blocks/TapOption.svelte';

	let {
		challenge,
		onanswer,
		targetLanguage = '',
		readings = ALL_READINGS,
		tokenize = null
	}: ChallengeProps<MatchPairsChallenge> = $props();

	/**
	 * Ruby for the **left** column only. `a` is the term and `b` is its meaning
	 * in the learner's own language — which is why only `aRom` is ever written —
	 * so romanizing the right column would be annotating English with pinyin.
	 */
	const ruby = $derived(rubyFor(tokenize, readings));

	/** Case/whitespace-insensitive text key, for matching tiles by content. */
	function textKey(text: string): string {
		return text.trim().toLowerCase().replace(/\s+/g, ' ');
	}

	/**
	 * True when `leftText` (a left-column tile) and `rightText` (a right-column
	 * tile) form a valid pair anywhere in `challenge.pairs` — not necessarily
	 * the specific pair either tile was built from.
	 */
	function isValidPair(leftText: string, rightText: string): boolean {
		const left = textKey(leftText);
		const right = textKey(rightText);
		return challenge.pairs.some((p) => textKey(p.a) === left && textKey(p.b) === right);
	}

	/** How long a wrong pair stays visibly wrong before it resets. */
	const SHAKE_MS = 460;
	/** Beat between the last pair locking in and the round reporting itself. */
	const FINISH_MS = 420;

	interface Tile {
		/**
		 * Index into `challenge.pairs` this tile was built from — a stable
		 * per-tile identity (unique within its own column), *not* the only
		 * pair index it is allowed to match against. See {@link isValidPair}.
		 */
		pair: number;
		text: string;
		rom?: string;
	}

	function shuffled(tiles: Tile[]): Tile[] {
		const out = [...tiles];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}

	// Both columns are shuffled independently, otherwise the answer is the
	// identity mapping and the exercise is a row-by-row read.
	const left = $derived(
		shuffled(challenge.pairs.map((p, pair) => ({ pair, text: p.a, rom: p.aRom })))
	);
	const right = $derived(
		shuffled(challenge.pairs.map((p, pair) => ({ pair, text: p.b, rom: p.bRom })))
	);

	// Left and right tiles are tracked as separate "consumed" sets: a
	// cross-pair match (text-equivalent but built from different original
	// pairs) locks in one specific tile on each side, not a single shared
	// pair index.
	let matchedLeft = $state<number[]>([]);
	let matchedRight = $state<number[]>([]);
	let selectedLeft = $state<number | null>(null);
	let selectedRight = $state<number | null>(null);
	let wrong = $state<{ left: number; right: number } | null>(null);
	let poppedLeft = $state<number | null>(null);
	let poppedRight = $state<number | null>(null);
	let mistakes = $state(0);
	let busy = $state(false);
	let done = $state(false);

	let timers: ReturnType<typeof setTimeout>[] = [];

	function later(fn: () => void, ms: number): void {
		timers.push(setTimeout(fn, ms));
	}

	const lock = createAnswerLock(
		() => challenge.id,
		() => {
			matchedLeft = [];
			matchedRight = [];
			selectedLeft = null;
			selectedRight = null;
			wrong = null;
			poppedLeft = null;
			poppedRight = null;
			mistakes = 0;
			busy = false;
			done = false;
		}
	);

	// Separate from the reset: a cleanup that cancelled the reset's own writes
	// would be a different thing entirely. This one only stops timers from the
	// round that just left the screen.
	$effect(() => {
		void challenge.id;
		return () => {
			for (const timer of timers) clearTimeout(timer);
			timers = [];
		};
	});

	const remaining = $derived(challenge.pairs.length - matchedLeft.length);

	function isMatchedLeft(pair: number): boolean {
		return matchedLeft.includes(pair);
	}

	function isMatchedRight(pair: number): boolean {
		return matchedRight.includes(pair);
	}

	function resolve(): void {
		if (selectedLeft === null || selectedRight === null) return;

		// Text equivalence, not object identity: any selected left+right pair
		// whose texts form a valid pair anywhere in `challenge.pairs` counts,
		// so two tiles carrying the same label (should one ever slip past the
		// generator's dedupe) are interchangeable rather than unmatchable.
		if (isValidPair(challenge.pairs[selectedLeft].a, challenge.pairs[selectedRight].b)) {
			const leftPair = selectedLeft;
			const rightPair = selectedRight;
			matchedLeft = [...matchedLeft, leftPair];
			matchedRight = [...matchedRight, rightPair];
			poppedLeft = leftPair;
			poppedRight = rightPair;
			selectedLeft = null;
			selectedRight = null;
			later(() => {
				poppedLeft = null;
				poppedRight = null;
			}, 400);

			if (matchedLeft.length === challenge.pairs.length && !done) {
				done = true;
				busy = true;
				later(finish, FINISH_MS);
			}
			return;
		}

		mistakes++;
		wrong = { left: selectedLeft, right: selectedRight };
		busy = true;
		later(() => {
			wrong = null;
			selectedLeft = null;
			selectedRight = null;
			busy = false;
		}, SHAKE_MS);
	}

	function finish(): void {
		onanswer({
			answerGiven: `${challenge.pairs.length} pairs, ${mistakes} mistake${mistakes === 1 ? '' : 's'}`,
			// A clean sweep is 'correct'; any misfire is 'almost'. Never 'wrong':
			// the round is only over once every pair has actually been matched.
			verdict: mistakes === 0 ? 'correct' : 'almost',
			responseMs: lock.commit()
		});
	}

	/** What a tile is currently showing, in `TapOption`'s vocabulary. */
	function stateOf(matched: boolean, selected: boolean, shaking: boolean) {
		if (shaking) return 'wrong' as const;
		if (matched) return 'correct' as const;
		return selected ? ('selected' as const) : ('idle' as const);
	}

	/**
	 * The left column is the target language, so picking a tile is a free chance
	 * to hear it — the round is otherwise silent reading. Only on *selection*: a
	 * deselecting tap is the learner taking a choice back, not asking again, and
	 * `speak` cuts off whatever is playing anyway. Failures are swallowed inside
	 * `speak`, so nothing here can stall the round.
	 */
	function tapLeft(pair: number): void {
		if (busy || done || isMatchedLeft(pair)) return;
		const selecting = selectedLeft !== pair;
		selectedLeft = selecting ? pair : null;
		if (selecting) void speak(challenge.pairs[pair].a, targetLanguage);
		resolve();
	}

	function tapRight(pair: number): void {
		if (busy || done || isMatchedRight(pair)) return;
		selectedRight = selectedRight === pair ? null : pair;
		resolve();
	}
</script>

<div class="match">
	<PromptHeader
		kicker="Tap the matching pairs"
		size="md"
		prompt={remaining > 0
			? `${remaining} pair${remaining === 1 ? '' : 's'} to go`
			: 'All matched — nice.'}
	/>

	<div class="columns">
		<div class="column">
			{#each left as tile (tile.pair)}
				<TapOption
					text={tile.text}
					reading={(readings.sentence ? tile.rom : '') ?? ''}
					tokens={ruby(tile.text)}
					fill
					selection="toggle"
					state={stateOf(
						isMatchedLeft(tile.pair),
						selectedLeft === tile.pair,
						wrong?.left === tile.pair
					)}
					pop={poppedLeft === tile.pair}
					disabled={isMatchedLeft(tile.pair) || done}
					onclick={() => tapLeft(tile.pair)}
				/>
			{/each}
		</div>

		<div class="column">
			{#each right as tile (tile.pair)}
				<TapOption
					text={tile.text}
					reading={(readings.sentence ? tile.rom : '') ?? ''}
					fill
					selection="toggle"
					state={stateOf(
						isMatchedRight(tile.pair),
						selectedRight === tile.pair,
						wrong?.right === tile.pair
					)}
					pop={poppedRight === tile.pair}
					disabled={isMatchedRight(tile.pair) || done}
					onclick={() => tapRight(tile.pair)}
				/>
			{/each}
		</div>
	</div>
</div>

<style>
	.match {
		display: flex;
		flex-direction: column;
	}

	/*
	  A notebook spread: two facing columns with the app's stitched hairline
	  running down the seam between them. The tiles are opaque, so the rule only
	  ever shows in the gutter — which is exactly where a seam belongs.
	*/
	.columns {
		position: relative;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.9rem;
	}

	.columns::before {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		border-left: 1px dashed var(--border-strong);
		opacity: 0.75;
		pointer-events: none;
	}

	.column {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	@media (max-width: 400px) {
		.columns {
			gap: 0.6rem;
		}
	}
</style>
