/**
 * `transcribe` — a local recording's subtitles, made on the desktop host from
 * what is said and what is burnt into the picture.
 *
 * Speech first: the audio a window at a time through the host's VAD and
 * SenseVoice (`asr_segments`), each span timed. Then the screen: one or two
 * frames per span, the bottom band only, through the host's OCR, keeping the
 * lines in the target's script — and if the first {@link PROBE_SPANS} spans'
 * frames gave nothing the core would take, the rest are not read, so a video
 * without hardsubs costs the speech pass alone. The core merges the two
 * (`mergeTranscript`) into an SRT file, and the result carries that file like
 * `captions` carries a fetched track: it lands in the composer's source card
 * and goes through `importSource` like an uploaded one. Nothing is stored; the
 * host's staged copy is released whatever happens.
 */

import { installAsrModel, heardSpans } from '$lib/asr/native';
import { importSource, mergeTranscript } from '$lib/db';
import { newUuid } from '$lib/device';
import {
	AUDIO_WINDOW_MS,
	MIN_LINE_SCORE,
	PROBE_SPANS,
	framesFor,
	keepSpans,
	mediaAudio,
	mediaFrame,
	probeMedia,
	releaseMedia,
	stageMedia,
	subtitleRect
} from '$lib/media';
import type { Span } from '$lib/media';
import { modelSet, ocrPage, scriptFor } from '$lib/ocr';
import { inTargetScript } from '$lib/text';
import type { TaskKindDef } from '../types';

export interface TranscribeInput {
	/** The picked recording; kept in memory for Retry, never stored. */
	file: File;
	/** The target language's BCP-47 tag: which lines on screen are its script. */
	tag: string;
}

export interface TranscribeResult {
	/** What to call the file in the source card. */
	name: string;
	/** The subtitles as SRT, for the composer to import. */
	text: string;
	lines: number;
	/** How many lines came from the subtitles on screen rather than the speech. */
	read: number;
}

export const transcribeTask = {
	// One recording at a time: each holds the recognizer and the decoder.
	serial: true,

	title(input) {
		return `Transcribe · ${input.file.name}`;
	},

	async run({ file, tag }, ctx) {
		const { signal } = ctx;
		ctx.step('model', 'Getting the speech models');
		await installAsrModel();

		ctx.step('stage', 'Opening the recording');
		const id = newUuid();
		try {
			await stageMedia(
				id,
				file,
				(done, total) => ctx.progress(done / 1e6, total / 1e6, 'MB'),
				signal
			);
			const info = await probeMedia(id);
			if (!info.audio) throw new Error('That recording has no sound to transcribe.');

			ctx.step('listen', 'Listening');
			const heard: Span[] = [];
			for (let from = 0; from < info.durationMs;) {
				signal.throwIfAborted();
				const to = Math.min(from + AUDIO_WINDOW_MS, info.durationMs);
				const spans = (await heardSpans(await mediaAudio(id, from, to))).map((span) => ({
					start: from + span.startMs,
					end: from + span.endMs,
					text: span.text
				}));
				const { keep, next } = keepSpans(spans, from, to, info.durationMs);
				heard.push(...keep);
				from = next;
				ctx.progress(Math.round(from / 1000), Math.round(info.durationMs / 1000), 's');
			}
			if (heard.length === 0) throw new Error('No speech was found in that recording.');

			const seen: { at: number; lines: string[] }[] = [];
			if (info.width > 0) {
				ctx.step('read', 'Reading the subtitles');
				const set = modelSet(scriptFor(tag), 'mobile');
				const rect = subtitleRect(info.width, info.height);
				for (const [i, span] of heard.entries()) {
					for (const at of framesFor(span)) {
						signal.throwIfAborted();
						const { lines } = await ocrPage(await mediaFrame(id, at, rect), set, 'auto');
						const target = lines
							.filter((line) => line.score >= MIN_LINE_SCORE && inTargetScript(line.text, tag))
							.map((line) => line.text);
						if (target.length > 0) seen.push({ at, lines: target });
					}
					ctx.progress(i + 1, heard.length, 'lines');
					if (i + 1 === PROBE_SPANS && heard.length > PROBE_SPANS) {
						const probe = await mergeTranscript({ heard: heard.slice(0, PROBE_SPANS), seen });
						if (probe.read === 0) break;
					}
				}
			}

			ctx.step('merge', 'Putting it together');
			const merged = await mergeTranscript({ heard, seen });
			const { segments } = await importSource(merged.srt);
			if (segments.length === 0) throw new Error('Nothing readable came out of that recording.');
			return {
				name: `${file.name} (transcribed)`,
				text: merged.srt,
				lines: segments.length,
				read: merged.read
			};
		} finally {
			void releaseMedia(id);
		}
	},

	summary(result) {
		const lines = `${result.lines} line${result.lines === 1 ? '' : 's'}`;
		return result.read > 0 ? `${lines}, ${result.read} read off the screen` : `${lines} heard`;
	}
} satisfies TaskKindDef<TranscribeInput, TranscribeResult>;
