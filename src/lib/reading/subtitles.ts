/**
 * Subtitles as an import format: a `.srt`/`.vtt` file, or the transcript panel
 * off a video page, turned into sentences that carry when they are spoken.
 *
 * The learner's route to a text is usually a video they are already watching,
 * and the subtitle file is the one artefact of it they can actually get hold
 * of (`yt-dlp --write-subs --write-auto-subs --sub-format vtt`, or the "Show
 * transcript" panel, copied). What arrives is not prose: it is a hundred
 * fragments cut to fit a screen for two seconds each, and the cut has nothing
 * to do with where the sentences are. So this module does the opposite of what
 * a subtitle renderer does — it *undoes* the cueing, joins the text back into a
 * running one, hands it to `./sentences` to be split the way any pasted text
 * is, and then hands each sentence back the timings of the cues its characters
 * came from.
 *
 * Those timings are stored and, for now, unread: there is no player in this
 * slice. They are kept because this is the only moment they exist — the file
 * is gone as soon as the import finishes, and re-deriving them later would mean
 * asking the learner for it again.
 *
 * Pure and dependency-free in the house style, like `./sentences` and
 * `./pages`: no DB, no clock, no network. Everything here is a function of the
 * file's own bytes.
 */

import { hasSentenceEnd, splitSentences } from './sentences';

/** The three shapes a learner actually turns up with. */
export type SubtitleFormat = 'srt' | 'vtt' | 'youtube-transcript';

/** One subtitle cue: a span of the media, and what is said in it. */
export interface Cue {
	/** Milliseconds from the start of the media. */
	start: number;
	/** Milliseconds from the start of the media; never before {@link start}. */
	end: number;
	/** Cleaned and joined — no markup, no entities, no line breaks. */
	text: string;
}

/** One sentence of the finished import, with the span of media it covers. */
export interface TimedSentence {
	text: string;
	start: number;
	end: number;
}

/**
 * How long the last cue of a transcript panel is assumed to last.
 *
 * The panel prints a start time per line and no end times at all, so every cue
 * but the last takes its end from the next one's start. The last has nothing
 * after it; four seconds is a spoken sentence, and the only thing that depends
 * on the guess is where a future player would stop highlighting.
 */
const LAST_CUE_MS = 4000;

/**
 * A character that sets its own spacing, so joining across it must not insert
 * one.
 *
 * Script extensions rather than plain scripts, because that is what pulls in
 * the shared punctuation: `。` and `、` are `Script=Common` but carry Han,
 * Hiragana, Katakana and Hangul in their extensions, and a line ending in a
 * full stop is the common case in a subtitle file. The fullwidth ASCII block is
 * listed by hand for the same reason and gets no help from extensions — `，`
 * and `？` are Common and stay Common.
 */
const CJK =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}！-｠]/u;

/** A transcript-panel timestamp on a line of its own: `0:04`, `1:02:33`. */
const PANEL_TIME = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;

/** An SRT block's header: the index line, then a `,`-separated timing line. */
const SRT_BLOCK = /(^|\n)[ \t]*\d+[ \t]*\n\d{1,2}:\d{2}:\d{2},\d{3}[ \t]*-->/;

/**
 * The separator between two pieces of text that were on different lines.
 *
 * A space everywhere except between two CJK characters, where a space is not a
 * word boundary but a visible mark the source did not have — and one the
 * tokenizer would then have to reproduce, since concatenating tokens has to
 * give the sentence back character for character.
 */
function joiner(before: string, after: string): string {
	if (!before || !after) return '';
	const left = before[before.length - 1];
	const right = after[0];
	return CJK.test(left) && CJK.test(right) ? '' : ' ';
}

/** Joins already-trimmed pieces, spacing each seam by {@link joiner}. */
function joinPieces(pieces: readonly string[]): string {
	let out = '';
	for (const piece of pieces) {
		if (!piece) continue;
		out += joiner(out, piece) + piece;
	}
	return out;
}

/** CRLF and the byte-order mark a downloaded file arrives wearing. */
function normalizeNewlines(text: string): string {
	return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * `HH:MM:SS.mmm`, `MM:SS.mmm`, either separator, in milliseconds.
 *
 * VTT writes the fraction with a dot and SRT with a comma, and both are seen
 * with the hours omitted; there is no reason to be strict about which, since a
 * timestamp that parses is a timestamp whatever it was written by.
 */
function parseTimestamp(raw: string): number | undefined {
	const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(raw.trim());
	if (!match) return undefined;
	const [, hours, minutes, seconds, fraction] = match;
	return (
		Number(hours ?? 0) * 3600000 +
		Number(minutes) * 60000 +
		Number(seconds) * 1000 +
		Number(fraction.padEnd(3, '0'))
	);
}

/** `0:04` / `1:02:33`, in milliseconds. */
function parsePanelTimestamp(raw: string): number | undefined {
	const parts = raw.trim().split(':');
	if (parts.length < 2 || parts.length > 3) return undefined;
	const numbers = parts.map(Number);
	if (numbers.some((n) => !Number.isFinite(n))) return undefined;
	const [hours, minutes, seconds] = numbers.length === 3 ? numbers : [0, numbers[0], numbers[1]];
	return hours * 3600000 + minutes * 60000 + seconds * 1000;
}

/**
 * The named entities a subtitle file actually contains.
 *
 * `&amp;` is decoded last on purpose: a file that wrote `&amp;lt;` means a
 * literal `&lt;`, and decoding the ampersand first would turn it into a `<`.
 */
function decodeEntities(text: string): string {
	return text
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/**
 * One line of cue text, stripped of everything that is presentation.
 *
 * Every angle-bracket run goes: the styling tags (`<i>`, `<b>`, `<c.colorE5E5E5>`),
 * the voice spans (`<v Speaker>`), and the per-word timestamps
 * (`<00:00:01.240>`) auto-generated captions carry so a player can highlight a
 * word at a time. Stripping tags before decoding entities is what makes that
 * safe: a real `<` in the dialogue was written `&lt;` and is still an entity at
 * this point, so it cannot be mistaken for markup.
 */
function cleanLine(line: string): string {
	return decodeEntities(line.replace(/<[^>]*>/g, ''))
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Splits a file into its blank-line-separated blocks.
 *
 * Both SRT and VTT are block formats and a cue's text may not contain a blank
 * line, so this is very nearly the whole of the structure — see
 * {@link parseBlockCues} for the one place real files disagree.
 */
function blocks(text: string): string[] {
	return normalizeNewlines(text)
		.split(/\n[ \t]*\n+/)
		.map((block) => block.trim())
		.filter(Boolean);
}

/** Cue lines, already cleaned, with the empty ones dropped. */
interface RawCue {
	start: number;
	end: number;
	lines: string[];
}

/**
 * Reads the cues out of an SRT or VTT body.
 *
 * One reader for both, because after the header the two formats differ only in
 * how the fraction is punctuated and in what may appear around a cue: VTT
 * allows a `NOTE`/`STYLE`/`REGION` block, an optional identifier line before
 * the timing, and settings (`align:start position:0%`) after it. All of that is
 * presentation, and none of it survives here.
 *
 * The one repair: a block carrying no timing line, straight after a cue, is
 * folded back into that cue. YouTube's automatic captions leave the top line of
 * their rolling window blank until the window has filled, and a blank-line split
 * — which is what the format says and what every parser does — cuts the cue in
 * half there. Dropping the orphan would silently lose the opening line of the
 * transcript, so it is put back where it came from.
 */
function parseBlockCues(text: string): RawCue[] {
	const out: RawCue[] = [];
	let open = false;

	for (const block of blocks(text)) {
		const lines = block.split('\n');
		if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) {
			open = false;
			continue;
		}

		const arrowAt = lines.findIndex((line) => line.includes('-->'));
		// `arrowAt + 1` is 0 when there is no timing line, which is right: an
		// orphan block is text all the way down.
		const body = lines
			.slice(arrowAt + 1)
			.map(cleanLine)
			.filter(Boolean);

		if (arrowAt < 0) {
			if (open) out[out.length - 1].lines.push(...body);
			continue;
		}

		// Everything before the arrow is an index or an identifier; everything
		// after the second timestamp on the arrow line is cue settings.
		const [rawStart, rest] = lines[arrowAt].split('-->');
		const start = parseTimestamp(rawStart);
		const end = parseTimestamp((rest ?? '').trim().split(/\s+/)[0] ?? '');
		if (start === undefined || end === undefined) {
			open = false;
			continue;
		}

		out.push({ start, end: Math.max(end, start), lines: body });
		open = true;
	}

	return out;
}

/**
 * Reads a transcript panel: alternating timestamp and text lines.
 *
 * The panel prints no end times, so a cue runs until the next one starts and
 * the last one gets {@link LAST_CUE_MS}. A line that is not a timestamp belongs
 * to whichever timestamp preceded it, so a two-line caption still lands in one
 * cue.
 */
function parsePanelCues(text: string): RawCue[] {
	const out: RawCue[] = [];

	for (const raw of normalizeNewlines(text).split('\n')) {
		const line = raw.trim();
		if (!line) continue;

		if (PANEL_TIME.test(line)) {
			const start = parsePanelTimestamp(line);
			if (start === undefined) continue;
			out.push({ start, end: start + LAST_CUE_MS, lines: [] });
			continue;
		}

		const cleaned = cleanLine(line);
		// Text before the first timestamp is the panel's own chrome ("Transcript",
		// a language menu) and belongs to no cue.
		if (cleaned && out.length > 0) out[out.length - 1].lines.push(cleaned);
	}

	for (let i = 0; i < out.length - 1; i++) {
		out[i].end = Math.max(out[i + 1].start, out[i].start);
	}
	return out.filter((cue) => cue.lines.length > 0);
}

/**
 * Which of the three shapes `text` is, or `undefined` for ordinary prose.
 *
 * The point of returning `undefined` rather than guessing is that the plain
 * paste path is still the common one: a learner who pastes an article must not
 * have it reinterpreted because one line of it happened to look like a
 * timestamp.
 */
export function detectSubtitleFormat(text: string): SubtitleFormat | undefined {
	const normalized = normalizeNewlines(text).trimStart();
	if (!normalized) return undefined;
	if (/^WEBVTT/.test(normalized)) return 'vtt';
	if (SRT_BLOCK.test('\n' + normalized)) return 'srt';

	// A panel starts on a timestamp and alternates: two cues that both carry
	// text is enough, and is not something prose does by accident.
	const lines = normalized.split('\n').map((line) => line.trim());
	const first = lines.find(Boolean);
	if (!first || !PANEL_TIME.test(first)) return undefined;
	return parsePanelCues(normalized).length >= 2 ? 'youtube-transcript' : undefined;
}

/**
 * Drops the repetition out of auto-generated captions.
 *
 * YouTube's automatic captions do not cue a line and move on: they *roll*. Each
 * cue repeats the line already on screen and adds the next one under it, and
 * between every pair sits a ten-millisecond transition cue that shows the same
 * text again with the top line scrolled off. Read literally, a five-minute
 * video yields every sentence three times.
 *
 * So a line is emitted the first time it is seen and never again, and a cue
 * that has nothing left after that is dropped — which disposes of the
 * transition cues without having to recognise them by their duration. The line
 * keeps the timing of the cue it first appeared in, which is the cue in which
 * it was actually spoken.
 *
 * Applied to every block-format file, not only the auto-generated ones: two
 * consecutive cues carrying identical text are a subtitle held across a shot
 * change, and reading it twice is wrong there too.
 */
function dedupeRolling(cues: readonly RawCue[]): Cue[] {
	const out: Cue[] = [];
	let previous = '';

	for (const cue of cues) {
		const fresh: string[] = [];
		for (const line of cue.lines) {
			if (line === previous) continue;
			fresh.push(line);
			previous = line;
		}
		if (fresh.length === 0) continue;
		out.push({ start: cue.start, end: cue.end, text: joinPieces(fresh) });
	}

	return out.filter((cue) => cue.text !== '');
}

/**
 * Every cue of `text`, in order, cleaned and de-duplicated.
 *
 * Returns an empty array for anything {@link detectSubtitleFormat} does not
 * recognise, so a caller may hand it a paste it has not classified.
 */
export function parseSubtitles(text: string): Cue[] {
	const format = detectSubtitleFormat(text);
	if (!format) return [];
	const raw = format === 'youtube-transcript' ? parsePanelCues(text) : parseBlockCues(text);
	return dedupeRolling(raw);
}

/**
 * One sentence per cue — the fallback for a transcript with no punctuation.
 *
 * Automatic captions frequently carry no sentence-final mark anywhere, and
 * joining those cues would hand `./sentences` one unbroken string and get one
 * sentence back: a whole video as a single line, unreadable and impossible to
 * page. The cue boundaries are then the only structure the file has, so they
 * become the sentence boundaries — which is also what the timings are already
 * shaped like.
 */
function sentencePerCue(cues: readonly Cue[]): TimedSentence[] {
	return cues.map((cue) => ({ text: cue.text, start: cue.start, end: cue.end }));
}

/**
 * Cues joined back into a running text, cut into sentences, and given back
 * their timings.
 *
 * The join is the interesting half. `splitSentences` also splits on every hard
 * newline — deliberately, since a line break in a pasted text is an authorial
 * decision — so joining cues with newlines would simply reinstate the cueing
 * this module exists to undo. The separator is therefore a space (or nothing,
 * between CJK characters), and the sentence boundaries are then recovered by
 * position: the split is a *cut*, so every sentence is a contiguous substring
 * of the joined text and they occur in order, which is exactly what a cursor
 * and `indexOf` need. A sentence's `start` is the cue holding its first
 * character and its `end` the cue holding its last.
 */
export function cuesToSentences(cues: readonly Cue[]): TimedSentence[] {
	const usable = cues.filter((cue) => cue.text.trim() !== '');
	if (usable.length === 0) return [];
	if (!usable.some((cue) => hasSentenceEnd(cue.text))) return sentencePerCue(usable);

	// Where each cue's text ends in the joined string. Separators fall in the
	// gaps between the spans and belong to no cue — which is safe, because
	// `splitSentences` trims, so no sentence begins or ends on one.
	const ends: number[] = [];
	let joined = '';
	for (const cue of usable) {
		joined += joiner(joined, cue.text) + cue.text;
		ends.push(joined.length);
	}

	const out: TimedSentence[] = [];
	let cursor = 0;
	// Monotone, because the sentences come back in the order they were cut.
	let first = 0;

	for (const sentence of splitSentences(joined)) {
		const at = joined.indexOf(sentence, cursor);
		if (at < 0) continue;
		cursor = at + sentence.length;

		while (first < usable.length - 1 && ends[first] <= at) first++;
		let last = first;
		while (last < usable.length - 1 && ends[last] < cursor) last++;

		out.push({
			text: sentence,
			start: usable[first].start,
			end: Math.max(usable[last].end, usable[first].start)
		});
	}

	return out;
}
