<!--
  One subtitle cue of a YouTube video, played on request.

  The player mounts with the stage, so its load is spent while the learner
  reads, not after the press. The seek waits for the press too: YouTube starts
  a cued video it is asked to seek, and nothing here plays uninvited.
-->
<script lang="ts">
	import { untrack } from 'svelte';

	import { crossedStop, paddedSpan, youtubePlayerForHost, type Player } from '$lib/media';

	let {
		videoId,
		start,
		end,
		onfail
	}: {
		videoId: string;
		/** The cue's span, in milliseconds into the recording. */
		start: number;
		end: number;
		/** The player could not load or play; the stage has already gone. */
		onfail?: () => void;
	} = $props();

	let frame = $state<HTMLDivElement | undefined>(undefined);
	let player: Player | undefined;
	let failed = $state(false);
	let played = $state(false);
	/** Whether the stop belongs to a press: playing on from the native controls is the learner's. */
	let armed = false;

	const span = $derived(paddedSpan(start, end));

	$effect(() => {
		const el = frame;
		const id = videoId;
		if (!el) return;
		const built = untrack(() =>
			youtubePlayerForHost(el, id, {
				onFail: () => {
					failed = true;
					onfail?.();
				}
			})
		);
		player = built;
		let last = built.currentTime();
		const stop = built.onTime((ms) => {
			const before = last;
			last = ms;
			if (
				armed &&
				crossedStop(
					untrack(() => span.to),
					before,
					ms
				)
			) {
				armed = false;
				built.pause();
			}
		});
		return () => {
			stop();
			built.destroy();
			player = undefined;
		};
	});

	function play(): void {
		if (!player) return;
		armed = true;
		played = true;
		player.seek(span.from);
		player.play();
	}
</script>

{#if !failed}
	<div class="clip">
		<div class="frame" bind:this={frame}></div>
		<button type="button" class="btn btn-ghost play" onclick={play}>
			<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" /></svg>
			{played ? 'Replay' : 'Play'}
		</button>
	</div>
{/if}

<style>
	.clip {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.45rem;
	}

	.frame {
		width: min(100%, 18rem);
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--text) 85%, transparent);
	}

	.frame :global(iframe) {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}

	.play {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.85rem;
		font-size: 0.85rem;
	}

	.ico {
		width: 1rem;
		height: 1rem;
		fill: currentColor;
	}
</style>
