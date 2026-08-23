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
-->
<script lang="ts">
	import type { AnswerEvent } from '$lib/session/engine';
	import { speak } from '$lib/tts';
	import type { MatchPairsChallenge } from '$lib/types';
	import { getShowRomanization } from '$lib/ui/prefs';

	let {
		challenge,
		onanswer,
		targetLanguage = ''
	}: {
		challenge: MatchPairsChallenge;
		onanswer: (event: AnswerEvent) => void;
		targetLanguage?: string;
	} = $props();

	/** Read once — the toggle lives in Settings, not mid-session. */
	const showRomanization = getShowRomanization();

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
	let shownAt = $state(Date.now());

	let timers: ReturnType<typeof setTimeout>[] = [];

	function later(fn: () => void, ms: number): void {
		timers.push(setTimeout(fn, ms));
	}

	$effect(() => {
		void challenge.id;
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
		shownAt = Date.now();

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
			responseMs: Date.now() - shownAt
		});
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
	<p class="asked">Tap the matching pairs</p>
	<p class="sub">
		{remaining > 0
			? `${remaining} pair${remaining === 1 ? '' : 's'} to go`
			: 'All matched — nice.'}
	</p>

	<div class="columns">
		<div class="column">
			{#each left as tile (tile.pair)}
				<button
					type="button"
					class="tile"
					class:selected={selectedLeft === tile.pair}
					class:matched={isMatchedLeft(tile.pair)}
					class:ll-pop={poppedLeft === tile.pair}
					class:ll-shake={wrong?.left === tile.pair}
					disabled={isMatchedLeft(tile.pair) || done}
					aria-pressed={selectedLeft === tile.pair}
					onclick={() => tapLeft(tile.pair)}
				>
					<span>{tile.text}</span>
					{#if showRomanization && tile.rom}
						<span class="rom">{tile.rom}</span>
					{/if}
				</button>
			{/each}
		</div>

		<div class="column">
			{#each right as tile (tile.pair)}
				<button
					type="button"
					class="tile"
					class:selected={selectedRight === tile.pair}
					class:matched={isMatchedRight(tile.pair)}
					class:ll-pop={poppedRight === tile.pair}
					class:ll-shake={wrong?.right === tile.pair}
					disabled={isMatchedRight(tile.pair) || done}
					aria-pressed={selectedRight === tile.pair}
					onclick={() => tapRight(tile.pair)}
				>
					<span>{tile.text}</span>
					{#if showRomanization && tile.rom}
						<span class="rom">{tile.rom}</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.match {
		display: flex;
		flex-direction: column;
	}

	.asked {
		margin: 0 0 0.2rem;
		font-size: 0.78rem;
		font-weight: 800;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.sub {
		margin: 0 0 1.4rem;
		font-size: 1.35rem;
		font-weight: 800;
		letter-spacing: -0.01em;
	}

	.columns {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.7rem;
	}

	.column {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.tile {
		min-height: 3.4rem;
		padding: 0.7rem 0.75rem;
		border: 2px solid var(--border);
		border-bottom-width: 4px;
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		font-weight: 700;
		line-height: 1.25;
		cursor: pointer;
		overflow-wrap: anywhere;
		transition:
			border-color 0.12s ease,
			background 0.12s ease,
			opacity 0.25s ease,
			transform 0.08s ease;
	}

	.tile:hover:not(:disabled) {
		background: var(--surface-alt);
	}

	.tile:active:not(:disabled) {
		transform: translateY(2px);
		border-bottom-width: 2px;
	}

	.tile:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	.tile.selected {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.tile.matched {
		border-color: var(--primary);
		background: var(--primary-soft);
		color: var(--primary-strong);
		opacity: 0.5;
		cursor: default;
	}

	/*
	  The shake and pop classes come from app.css so all three interactive
	  challenge types share one definition (and one reduced-motion opt-out).
	  The wrong pair also flips to danger colours, which reduced motion keeps.
	*/
	.tile.ll-shake {
		border-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 14%, transparent);
		color: var(--danger);
	}

	@media (max-width: 480px) {
		.sub {
			font-size: 1.15rem;
		}

		.tile {
			font-size: 0.95rem;
		}
	}
</style>
