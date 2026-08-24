/**
 * Unit tests for the shared digit-select + Enter rule.
 *
 * The point of extracting it was that two components had implemented it twice;
 * these pin the behaviour both of them had, including the parts that are easy
 * to get subtly wrong — an out-of-range digit is *not* consumed, Enter with
 * nothing selected is *not* consumed, and a modified press is never ours.
 */

import { describe, expect, it } from 'vitest';

import { choiceKeyAction, type ChoiceKeyState, type KeyChord } from './keyboard';

function chord(key: string, modifiers: Partial<KeyChord> = {}): KeyChord {
	return { key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers };
}

/** The usual live state: four options, unlocked, nothing picked yet. */
function state(overrides: Partial<ChoiceKeyState> = {}): ChoiceKeyState {
	return { count: 4, locked: false, hasSelection: false, ...overrides };
}

describe('choiceKeyAction', () => {
	it('selects the option a digit names, zero-indexed', () => {
		expect(choiceKeyAction(chord('1'), state())).toEqual({ kind: 'select', index: 0 });
		expect(choiceKeyAction(chord('4'), state())).toEqual({ kind: 'select', index: 3 });
	});

	it('ignores digits past the option count, and zero', () => {
		expect(choiceKeyAction(chord('5'), state())).toEqual({ kind: 'ignore' });
		expect(choiceKeyAction(chord('0'), state())).toEqual({ kind: 'ignore' });
	});

	it('honours a larger count, as spot-error uses for a long sentence', () => {
		expect(choiceKeyAction(chord('9'), state({ count: 9 }))).toEqual({ kind: 'select', index: 8 });
		expect(choiceKeyAction(chord('9'), state({ count: 5 }))).toEqual({ kind: 'ignore' });
	});

	it('submits on Enter, but only once something is selected', () => {
		expect(choiceKeyAction(chord('Enter'), state({ hasSelection: true }))).toEqual({
			kind: 'submit'
		});
		expect(choiceKeyAction(chord('Enter'), state())).toEqual({ kind: 'ignore' });
	});

	it('ignores everything once the component has committed', () => {
		const locked = state({ locked: true, hasSelection: true });
		expect(choiceKeyAction(chord('2'), locked)).toEqual({ kind: 'ignore' });
		expect(choiceKeyAction(chord('Enter'), locked)).toEqual({ kind: 'ignore' });
	});

	it('leaves modified presses to the browser', () => {
		for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
			expect(choiceKeyAction(chord('2', { [modifier]: true }), state())).toEqual({
				kind: 'ignore'
			});
			expect(
				choiceKeyAction(chord('Enter', { [modifier]: true }), state({ hasSelection: true }))
			).toEqual({ kind: 'ignore' });
		}
	});

	it('ignores ordinary typing', () => {
		for (const key of ['a', 'Tab', 'ArrowDown', ' ', 'Escape']) {
			expect(choiceKeyAction(chord(key), state({ hasSelection: true }))).toEqual({
				kind: 'ignore'
			});
		}
	});
});
