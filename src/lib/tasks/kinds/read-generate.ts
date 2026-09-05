/**
 * `read-generate` — a text written out of the learner's own words.
 *
 * Wraps `generateReadingText` **and the save**: the page used to mint the id
 * and call `addText` after the call came back, which meant a learner who
 * left the page lost the text they had paid for. Now the text lands whether
 * or not anyone is watching, and the page that started the task opens it
 * from the outcome.
 */

import { addText } from '$lib/db';
import { newUuid } from '$lib/device';
import { generateReadingText } from '$lib/reading';
import type { FocusWord } from '$lib/reading';
import type { Profile, ReadingText } from '$lib/types';
import type { TaskKindDef } from '../types';

export interface ReadGenerateInput {
	profile: Profile;
	/** Every term the model may use freely: the garden plus the words marked known. */
	vocabulary: string[];
	/** Words the text must use at least once — the schedule's, most overdue first. */
	focus: FocusWord[];
	topic?: string;
}

/** What landed: enough for the page to open it, and for the tray to name it. */
export interface ReadTextResult {
	id: string;
	title: string;
}

export const readGenerateTask = {
	serial: true,

	title(input) {
		return input.topic ? `Writing “${input.topic}”` : 'Writing a text';
	},

	async run(input, ctx) {
		ctx.step('write', 'Writing the text');
		const draft = await generateReadingText(
			{
				profile: input.profile,
				vocabulary: input.vocabulary,
				focus: input.focus,
				...(input.topic ? { topic: input.topic } : {})
			},
			{ signal: ctx.signal }
		);

		ctx.step('save', 'Saving');
		const text: ReadingText = {
			title: draft.title,
			source: 'generated',
			...(input.topic ? { topic: input.topic } : {}),
			sentences: draft.sentences,
			glossary: draft.glossary,
			id: newUuid(),
			createdAt: Date.now()
		};
		await addText(text);
		return { id: text.id, title: text.title };
	},

	summary(result) {
		return `“${result.title}” is in your library`;
	}
} satisfies TaskKindDef<ReadGenerateInput, ReadTextResult>;
