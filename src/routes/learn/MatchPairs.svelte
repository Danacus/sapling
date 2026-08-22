<!--
  Match pairs: the free round.

  These challenges are built locally by `makeMatchPairsChallenge` out of words
  the learner already knows — zero tokens, zero network. They exist to break up
  the rhythm of a session and to give the combo somewhere to breathe.

  Interaction: pick one tile from each column. A correct pair locks in with a
  pop; a wrong pair shakes and both tiles deselect. Mistakes are counted, and a
  round finished with at least one mistake reports 'almost' instead of
  'correct' — that only affects XP, never SRS (see `applyResult`).
-->
<script lang="ts">
	import type { AnswerEvent } from '$lib/session/engine';
	import type { MatchPairsChallenge } from '$lib/types';

	let {
		challenge,
		onanswer
	}: { challenge: MatchPairsChallenge; onanswer: (event: AnswerEvent) => void } = $props();

	/** How long a wrong pair stays visibly wrong before it resets. */
	const SHAKE_MS = 460;
	/** Beat between the last pair locking in and the round reporting itself. */
	const FINISH_MS = 420;

	interface Tile {
		/** Index into `challenge.pairs` — the identity a match is checked against. */
		pair: number;
		text: string;
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
	const left = $derived(shuffled(challenge.pairs.map((p, pair) => ({ pair, text: p.a }))));
	const right = $derived(shuffled(challenge.pairs.map((p, pair) => ({ pair, text: p.b }))));

	let matched = $state<number[]>([]);
	let selectedLeft = $state<number | null>(null);
	let selectedRight = $state<number | null>(null);
	let wrong = $state<{ left: number; right: number } | null>(null);
	let popped = $state<number | null>(null);
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
		matched = [];
		selectedLeft = null;
		selectedRight = null;
		wrong = null;
		popped = null;
		mistakes = 0;
		busy = false;
		done = false;
		shownAt = Date.now();

		return () => {
			for (const timer of timers) clearTimeout(timer);
			timers = [];
		};
	});

	const remaining = $derived(challenge.pairs.length - matched.length);

	function isMatched(pair: number): boolean {
		return matched.includes(pair);
	}

	function resolve(): void {
		if (selectedLeft === null || selectedRight === null) return;

		if (selectedLeft === selectedRight) {
			const pair = selectedLeft;
			matched = [...matched, pair];
			popped = pair;
			selectedLeft = null;
			selectedRight = null;
			later(() => (popped = null), 400);

			if (matched.length === challenge.pairs.length && !done) {
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

	function tapLeft(pair: number): void {
		if (busy || done || isMatched(pair)) return;
		selectedLeft = selectedLeft === pair ? null : pair;
		resolve();
	}

	function tapRight(pair: number): void {
		if (busy || done || isMatched(pair)) return;
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
					class:matched={isMatched(tile.pair)}
					class:ll-pop={popped === tile.pair}
					class:ll-shake={wrong?.left === tile.pair}
					disabled={isMatched(tile.pair) || done}
					aria-pressed={selectedLeft === tile.pair}
					onclick={() => tapLeft(tile.pair)}
				>
					{tile.text}
				</button>
			{/each}
		</div>

		<div class="column">
			{#each right as tile (tile.pair)}
				<button
					type="button"
					class="tile"
					class:selected={selectedRight === tile.pair}
					class:matched={isMatched(tile.pair)}
					class:ll-pop={popped === tile.pair}
					class:ll-shake={wrong?.right === tile.pair}
					disabled={isMatched(tile.pair) || done}
					aria-pressed={selectedRight === tile.pair}
					onclick={() => tapRight(tile.pair)}
				>
					{tile.text}
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
