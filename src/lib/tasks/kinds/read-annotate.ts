/**
 * `read-annotate` — a text the learner imported, annotated and saved.
 *
 * The page still does everything that needs the page: it cuts the source into
 * sentences, recovers subtitle timings, and decides which recording (a file or
 * a link) the text plays alongside. What moves here is the call and the save,
 * so an article that takes seven calls to annotate still lands in the library
 * when the learner has long since gone to practise. The chunked call's
 * `onProgress` becomes the task's progress fraction, in calls.
 *
 * A file recording rides along as the `File` object itself (tasks are in
 * memory, so that is fine) and is handed to `$lib/media`'s session cache once
 * the id exists, exactly as the page did.
 */

import { addText } from '$lib/db';
import { newUuid } from '$lib/device';
import { rememberFile } from '$lib/media';
import { annotateReadingText } from '$lib/reading';
import type { Profile, ReadingMedia, ReadingSentence, ReadingText } from '$lib/types';
import type { TaskKindDef } from '../types';
import type { ReadTextResult } from './read-generate';

export interface ReadAnnotateInput {
	profile: Profile;
	vocabulary: string[];
	/** Exactly what was pasted, one entry per sentence. */
	sentences: string[];
	/** Index-aligned with `sentences`; present only for subtitles. */
	timings?: { start: number; end: number }[];
	/** The learner's own title, when they gave one. */
	title?: string;
	media?: ReadingMedia;
	/** The recording itself, when `media` is a file — never stored, only remembered. */
	file?: File;
}

export const readAnnotateTask = {
	serial: true,

	title(input) {
		return input.title ? `Annotating “${input.title}”` : 'Annotating a text';
	},

	async run(input, ctx) {
		const draft = await annotateReadingText(
			{
				profile: input.profile,
				vocabulary: input.vocabulary,
				sentences: input.sentences,
				...(input.title ? { title: input.title } : {})
			},
			{
				signal: ctx.signal,
				onProgress: (done, total) => ctx.progress(done, total, 'calls')
			}
		);

		// The timings never reach `$lib/reading`: it is handed strings and gives
		// back one annotation per string, so zipping them on by index is exact.
		const timings = input.timings;
		const sentences: ReadingSentence[] = timings
			? draft.sentences.map((sentence, i) =>
					timings[i] ? { ...sentence, ...timings[i] } : sentence
				)
			: draft.sentences;

		const text: ReadingText = {
			title: draft.title,
			source: 'imported',
			sentences,
			glossary: draft.glossary,
			...(input.media ? { media: input.media } : {}),
			id: newUuid(),
			createdAt: Date.now()
		};
		await addText(text);
		if (input.media?.kind === 'file' && input.file) rememberFile(text.id, input.file);
		return { id: text.id, title: text.title };
	},

	summary(result) {
		return `“${result.title}” is in your library`;
	}
} satisfies TaskKindDef<ReadAnnotateInput, ReadTextResult>;
