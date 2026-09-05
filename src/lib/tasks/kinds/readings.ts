/**
 * `readings` — the missing-pronunciations backfill from Settings.
 *
 * Local first, model second, exactly as the page did it: the readings the
 * local romanizer can answer for keeps are written **before** the model is
 * asked, so a failed call never costs the readings that never needed it. The
 * page works out the two lists (it needs them for its own copy) and hands
 * both over; this def owns the writes and the one call.
 */

import { upsertItems } from '$lib/db';
import { fillRomanizations } from '$lib/llm';
import type { KnowledgeItem } from '$lib/types';
import type { TaskKindDef } from '../types';

export interface ReadingsInput {
	targetLanguage: string;
	/** Items already patched with the reading the local romanizer worked out. */
	free: KnowledgeItem[];
	/** Items the model has to read — the polyphones. Empty skips the call. */
	fromModel: KnowledgeItem[];
}

export interface ReadingsResult {
	free: number;
	fromModel: number;
	/** Every item written, with its new reading — for the page to patch its list. */
	patched: KnowledgeItem[];
}

export const readingsTask = {
	serial: true,

	title(input) {
		const n = input.free.length + input.fromModel.length;
		return `${n} pronunciation${n === 1 ? '' : 's'}`;
	},

	async run(input, ctx) {
		const total = input.free.length + input.fromModel.length;
		ctx.progress(0, total, 'words');

		if (input.free.length > 0) await upsertItems(input.free);
		ctx.progress(input.free.length, total, 'words');

		let fromModel: KnowledgeItem[] = [];
		if (input.fromModel.length > 0) {
			const { readings } = await fillRomanizations(
				{
					items: input.fromModel.map((item) => ({ id: item.id, term: item.term })),
					targetLanguage: input.targetLanguage
				},
				{ signal: ctx.signal }
			);
			fromModel = input.fromModel
				.filter((item) => readings.has(item.id))
				.map((item) => ({ ...item, romanization: readings.get(item.id) as string }));
			if (fromModel.length > 0) await upsertItems(fromModel);
			ctx.progress(input.free.length + fromModel.length, total, 'words');
		}

		const patched = [...input.free, ...fromModel];
		// A call that came back with nothing is a failure the learner should see
		// as one, not a "done" with a count of zero.
		if (patched.length === 0) throw new Error('The model returned no usable readings.');
		return { free: input.free.length, fromModel: fromModel.length, patched };
	},

	summary(result) {
		const n = result.free + result.fromModel;
		const added = `Added ${n} reading${n === 1 ? '' : 's'}`;
		if (result.fromModel > 0 && result.free > 0)
			return `${added} (${result.fromModel} from the model)`;
		return added;
	}
} satisfies TaskKindDef<ReadingsInput, ReadingsResult>;
