import { describe, expect, it } from 'vitest';

import { multiClozeDef } from './multi-cloze';

const generated = {
	type: 'multi-cloze' as const,
	parts: [
		{ text: 'Primero quiero ', reading: null },
		{ text: '. Después pido la ', reading: null },
		{ text: '.', reading: null }
	],
	gaps: [
		{ itemId: 'i1', answer: { text: 'comer', reading: null } },
		{ itemId: 'i2', answer: { text: 'cuenta', reading: null } }
	],
	distractorWords: [
		{ text: 'mesa', reading: null },
		{ text: 'carta', reading: null },
		{ text: 'propina', reading: null },
		{ text: 'agua', reading: null }
	],
	itemIds: ['i1', 'i2'],
	explanation: null
};

const context = {
	base: { id: 'c1', itemIds: ['i1', 'i2'] },
	resolveItemRef: (ref: string) => (ref === 'i1' || ref === 'i2' ? ref : undefined),
	rng: () => 0.5,
	params: { words: 8, gaps: 2 }
};

describe('multi-cloze resolver', () => {
	it('puts every distinct answer into the shared bank, whole, and preserves the gap bindings', () => {
		const resolved = multiClozeDef.resolve(generated, context);
		expect(resolved).toMatchObject({
			type: 'multi-cloze',
			direction: 'toTarget',
			passage: 'Primero quiero ___1___. Después pido la ___2___.'
		});
		if (!resolved || resolved.type !== 'multi-cloze') return;
		expect(resolved.itemIds).toEqual(['i1', 'i2']);
		expect(resolved.gaps.map((gap) => gap.itemId)).toEqual(['i1', 'i2']);
		// No cap at resolve time any more: every surviving distractor is kept,
		// answers included. Sizing what a served challenge shows from it is
		// `$lib/session/support`'s job.
		expect(resolved.wordBank).toHaveLength(6);
		expect(resolved.wordBank).toEqual(expect.arrayContaining(['comer', 'cuenta']));
	});

	it('drops a passage that would require one bank word to fill two gaps', () => {
		const duplicateAnswer = {
			...generated,
			gaps: [generated.gaps[0], { ...generated.gaps[1], answer: generated.gaps[0].answer }]
		};
		expect(multiClozeDef.resolve(duplicateAnswer, context)).toBeNull();
	});
});
