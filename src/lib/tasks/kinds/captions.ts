/**
 * `captions` — a YouTube video's subtitle track, fetched by the desktop host.
 *
 * A task rather than an awaited call because it is two network round trips
 * through a program that has to read a watch page and run its JavaScript: ten
 * seconds is ordinary and a minute is possible, and the composer must not be a
 * frozen form for either. The runner owns the status and the tray carries the
 * failure, so the page holds nothing but the source card the result becomes.
 *
 * **The result carries the file, not a parse of it.** What comes back from the
 * host is raw `json3`, and this def hands the composer exactly that — because
 * `json3` is an *import format* (`$lib/reading/subtitles.ts`), so the fetched
 * text enters the identical path an uploaded `.srt` does: one `sourceFile`, one
 * `plan` derivation behind the card, the counter, the button and the import. A
 * parsed cue list would have been a second, parallel source of truth for the
 * one thing that composer deliberately derives once.
 *
 * The sentences are in the result too, and they are the reason this def parses
 * at all: a track that yields nothing readable is a failure worth reporting in
 * the tray rather than a dead Add button the learner has to work out for
 * themselves, and their count is what the summary says.
 */

import { fetchCaptions } from '$lib/media';
import type { CaptionTrack } from '$lib/media';
import { cuesToSentences, parseSubtitles } from '$lib/reading';
import type { TimedSentence } from '$lib/reading';
import type { TaskKindDef } from '../types';

/**
 * The video, and which of its tracks. Complete on purpose — the runner keeps an
 * input for Retry, so a fetch that failed on a rate limit can be re-run without
 * the composer having to still be showing the track list it came from.
 */
export interface CaptionsInput extends CaptionTrack {
	videoId: string;
}

export interface CaptionsResult {
	/** What to call the track where an uploaded file's name would go. */
	name: string;
	/** The track exactly as yt-dlp wrote it: `json3`, for the composer to import. */
	text: string;
	/** What it cuts into — counted by {@link captionsTask.summary}. */
	sentences: TimedSentence[];
}

export const captionsTask = {
	// Not serial: nothing here writes anything, and two videos' captions are two
	// independent programs. The rate limit that matters is YouTube's, and one
	// learner fetching one track at a time is nowhere near it.
	serial: false,

	// yt-dlp is a child process the host waits on and cannot be asked to stop
	// mid-fetch, so cancelling drops the record without ending the work — which
	// is what `cancellable: false` says, and what makes the tray word its button
	// "Stop watching" (`tts-model` is the same shape).
	cancellable: false,

	title(input) {
		return `Captions · ${input.name}`;
	},

	async run(input, ctx) {
		// Two steps, because the seconds go to two different things and a ledger
		// that said one thing for a minute would not be telling anyone anything.
		ctx.step('fetch', 'Asking yt-dlp');
		const text = await fetchCaptions(input.videoId, input);

		ctx.step('read', `Reading ${input.name}`);
		const sentences = cuesToSentences(parseSubtitles(text));
		if (sentences.length === 0) {
			throw new Error(`There is nothing readable in the ${input.name} track.`);
		}

		return { name: input.name, text, sentences };
	},

	summary(result) {
		const lines = result.sentences.length;
		return `${lines} line${lines === 1 ? '' : 's'} from ${result.name}`;
	}
} satisfies TaskKindDef<CaptionsInput, CaptionsResult>;
